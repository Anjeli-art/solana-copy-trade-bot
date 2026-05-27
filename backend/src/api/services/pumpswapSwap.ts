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
import { getJupiterSwapExecutionDetails } from "./jupiterSwap";
import { createBotLog } from "./logs";
import { closeTokenAccountIfEmpty } from "./ataRentRecovery";
import { getActualTokenBalance } from "./tokenBalance";
import { getCachedBlockhash, forceBlockhashRefresh } from "./caches/blockhashCache";
import { sendBuyViaJito } from "./jitoSender";

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
    /** Buy paths only — try Jito bundle first for slot-adjacent landing. */
    useJito?: boolean;
    tokenMint?: string;
  }
): Promise<{ signature: string; signatureCount: number }> {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  // Cached blockhash: background-refreshed every ~8s, saves ~80-100ms per send.
  let { blockhash, lastValidBlockHeight } = await getCachedBlockhash(connection);
  const buildTx = (hash: string, height: number) => {
    const tx = new Transaction({ blockhash: hash, lastValidBlockHeight: height, feePayer: wallet.publicKey });
    for (const ix of instructions) tx.add(ix);
    tx.sign(wallet);
    return tx;
  };
  let transaction = buildTx(blockhash, lastValidBlockHeight);

  if (options.shouldSend && !(await options.shouldSend())) {
    throw new Error("Swap aborted before send: trading was stopped");
  }

  let signature: string | null = null;

  if (options.useJito) {
    try {
      const jitoResult = await sendBuyViaJito(connection, wallet, transaction, options.tokenMint);
      signature = jitoResult.signature;
    } catch (jitoErr) {
      const msg = jitoErr instanceof Error ? jitoErr.message : String(jitoErr);
      createBotLog({
        level: "warn",
        event: "BUY_JITO_FALLBACK",
        message: `PumpSwap Jito bundle failed, falling back to RPC send: ${msg.slice(0, 120)}`,
        tokenMint: options.tokenMint,
        metadata: { reason: msg, route: "PumpSwap" }
      });
    }
  }

  if (!signature) {
    try {
      signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });
    } catch (err) {
      // Retry once on stale blockhash (cache TTL race).
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      if (!msg.includes("blockhash not found") && !msg.includes("blockhashnotfound")) throw err;
      const fresh = await forceBlockhashRefresh(connection);
      blockhash = fresh.blockhash;
      lastValidBlockHeight = fresh.lastValidBlockHeight;
      transaction = buildTx(blockhash, lastValidBlockHeight);
      signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });
    }
  }
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
  const t0 = Date.now();
  let tMetadata = t0;
  let tBuild = t0;
  let tSend = t0;
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const offlineSdk = new PumpAmmSdk();

    const poolKey = new PublicKey(poolAddress);
    const swapState = await onlineSdk.swapSolanaState(poolKey, wallet.publicKey);
    tMetadata = Date.now();

    const slippagePct = getSlippageBps() / 100; // SDK takes percentage
    const quoteLamports = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));

    // buyQuoteInput: I'm spending exactly `quoteLamports` SOL, want as much base as possible.
    const buyIxs = await offlineSdk.buyQuoteInput(swapState, quoteLamports, slippagePct);
    tBuild = Date.now();

    const allIxs = [...buildComputeBudgetInstructions(), ...buyIxs];
    // Jito disabled per user request — uncomment to re-enable.
    const { signature, signatureCount } = await sendAndConfirm(allIxs, {
      ...options
      // useJito: true,
      // tokenMint
    });
    tSend = Date.now();

    // Reuse Jupiter's execution-details reader — it just reads tx meta, not Jupiter-specific.
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "buy"
    });
    const tDone = Date.now();

    createBotLog({
      event: "BUY_TIMING",
      message: `PumpSwap buy ${tokenMint.slice(0, 8)}… total=${tDone - t0}ms`,
      tokenMint,
      signature,
      metadata: {
        platform: "PumpSwap",
        metadataMs: tMetadata - t0,
        buildMs: tBuild - tMetadata,
        sendConfirmMs: tSend - tBuild,
        execDetailsMs: tDone - tSend,
        totalMs: tDone - t0
      }
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

    // CRITICAL: sell the live on-chain ATA balance, not position.tokenAmount.
    // Drift (transfer fees, partial fills, dust) means trusting DB leaves residue
    // that blocks ATA close → rent stuck. Reading the real balance fixes both.
    const actual = await getActualTokenBalance(connection, wallet.publicKey, new PublicKey(tokenMint));
    const rawTokenAmount = actual.balanceRaw;
    const slippagePct = getSlippageBps() / 100;

    // sellBaseInput: I have exactly `rawTokenAmount` of base token, want as much SOL as possible.
    const sellIxs = await offlineSdk.sellBaseInput(swapState, rawTokenAmount, slippagePct);

    const allIxs = [...buildComputeBudgetInstructions(), ...sellIxs];
    const { signature, signatureCount } = await sendAndConfirm(allIxs, {});

    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "sell"
    });

    // Recover ~0.00204 SOL of ATA rent if the token account is now empty.
    // Best-effort: doesn't affect the sell result if it fails.
    closeTokenAccountIfEmpty(connection, wallet, new PublicKey(tokenMint)).catch((error) => {
      createBotLog({
        level: "warn",
        event: "ATA_CLOSE_UNHANDLED",
        message: error instanceof Error ? error.message : "Unhandled ATA close rejection",
        tokenMint,
        metadata: { route: "PumpSwap" }
      });
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
