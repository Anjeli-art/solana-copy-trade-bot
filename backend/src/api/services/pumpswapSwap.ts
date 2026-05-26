/**
 * Native PumpSwap buy/sell using the official @pump-fun/pump-swap-sdk.
 *
 * Provides executePumpSwapBuy / executePumpSwapSell with result shapes compatible
 * with executeJupiterBuy / executeJupiterSell so workers can route either way
 * based on position.buyPlatform.
 *
 * Compared to Jupiter routing through PumpSwap, this path:
 *   - skips Jupiter's HTTP /quote + /swap roundtrip (~500-900ms)
 *   - skips the Jupiter request slot queue (up to 2500ms wait)
 *   - costs fewer compute units (one program call vs Jupiter's routing wrapper)
 *
 * Only call this when the position / detected buy is confirmed to be on PumpSwap.
 * For all other DEXes, keep using Jupiter — the routing layer in copyTradeWorker /
 * profitWatcherWorker decides which path to take.
 */
import path from "path";
import dotenv from "dotenv";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { OnlinePumpAmmSdk, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { getJupiterSwapExecutionDetails, getJupiterTokenDecimals } from "./jupiterSwap";
import { createBotLog } from "./logs";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_SLIPPAGE_BPS = 200;
const BASE_SIGNATURE_FEE_LAMPORTS = 5000;
// Standard Jupiter-comparable priority fee. We bias slightly aggressive on native
// PumpSwap because the whole point is reducing latency end-to-end.
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 100_000;
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

export type PumpSwapSwapResult = {
  tokenMint: string;
  side: "buy" | "sell";
  route: "PumpSwap";
  signature: string;
  tokenAmountDelta?: number;
  outputSol?: number;
  networkFeeSol?: number;
  priorityFeeSol?: number;
  quotedOutAmount?: number;
  quotedOutSol?: number;
  actualSolChange?: number;
};

function getSlippageBps() {
  const value = Number(process.env.JUPITER_SLIPPAGE_BPS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SLIPPAGE_BPS;
}

function getPriorityFeeMicroLamports() {
  const value = Number(process.env.PUMPSWAP_PRIORITY_FEE_MICRO_LAMPORTS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
}

function getComputeUnitLimit() {
  const value = Number(process.env.PUMPSWAP_COMPUTE_UNIT_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_COMPUTE_UNIT_LIMIT;
}

function buildComputeBudgetInstructions(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: getComputeUnitLimit() }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: getPriorityFeeMicroLamports() })
  ];
}

async function sendAndConfirm(
  instructions: TransactionInstruction[],
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  }
): Promise<{ signature: string; signatureCount: number }> {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey });
  for (const ix of instructions) {
    transaction.add(ix);
  }
  transaction.sign(wallet);

  if (options.shouldSend && !(await options.shouldSend())) {
    throw new Error("Swap aborted before send: trading was stopped");
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  await options.onSignature?.(signature);
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  return { signature, signatureCount: transaction.signatures.length || 1 };
}

export async function executePumpSwapBuy(
  tokenMint: string,
  amountSol: number,
  poolAddress: string,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<PumpSwapSwapResult> {
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const offlineSdk = new PumpAmmSdk();

    const poolKey = new PublicKey(poolAddress);
    const swapState = await onlineSdk.swapSolanaState(poolKey, wallet.publicKey);

    const slippagePct = getSlippageBps() / 100; // SDK takes percentage
    const quoteLamports = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));

    // buyQuoteInput: I'm spending exactly `quoteLamports` SOL, want as much base as possible.
    const buyIxs = await offlineSdk.buyQuoteInput(swapState, quoteLamports, slippagePct);

    const allIxs = [...buildComputeBudgetInstructions(), ...buyIxs];
    const { signature, signatureCount } = await sendAndConfirm(allIxs, options);

    // Reuse Jupiter's execution-details reader — it just reads tx meta, not Jupiter-specific.
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount
    });

    return {
      tokenMint,
      side: "buy",
      route: "PumpSwap",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "PUMPSWAP_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown PumpSwap buy error",
      tokenMint,
      metadata: { side: "buy", amountSol, poolAddress }
    });
    throw error;
  }
}

export async function executePumpSwapSell(
  tokenMint: string,
  tokenAmount: number,
  poolAddress: string
): Promise<PumpSwapSwapResult> {
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const offlineSdk = new PumpAmmSdk();

    const poolKey = new PublicKey(poolAddress);
    const swapState = await onlineSdk.swapSolanaState(poolKey, wallet.publicKey);

    const tokenDecimals = await getJupiterTokenDecimals(tokenMint);
    const rawTokenAmount = new BN(Math.max(1, Math.floor(tokenAmount * 10 ** tokenDecimals)).toString());
    const slippagePct = getSlippageBps() / 100;

    // sellBaseInput: I have exactly `rawTokenAmount` of base token, want as much SOL as possible.
    const sellIxs = await offlineSdk.sellBaseInput(swapState, rawTokenAmount, slippagePct);

    const allIxs = [...buildComputeBudgetInstructions(), ...sellIxs];
    const { signature, signatureCount } = await sendAndConfirm(allIxs, {});

    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount
    });

    const outputSol = execDetails.actualSolChange !== undefined ? Math.abs(execDetails.actualSolChange) : 0;
    return {
      tokenMint,
      side: "sell",
      route: "PumpSwap",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      outputSol,
      quotedOutSol: outputSol,
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "PUMPSWAP_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown PumpSwap sell error",
      tokenMint,
      metadata: { side: "sell", tokenAmount, poolAddress }
    });
    throw error;
  }
}

// Unused but exported for future use (e.g. Phase 3 quote comparison).
export const PUMPSWAP_BASE_FEE_LAMPORTS = BASE_SIGNATURE_FEE_LAMPORTS;
