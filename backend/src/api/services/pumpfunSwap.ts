/**
 * Native Pump.fun bonding-curve buy/sell using the official @pump-fun/pump-sdk.
 *
 * Drop-in alternative to executeJupiterBuy / executeJupiterSell for tokens still
 * on the bonding curve (before they graduate to PumpSwap). Once graduated, the
 * bonding curve's `complete` flag flips and the position should sell through
 * Jupiter (or PumpSwap native) instead.
 *
 * Result shape matches PumpSwapSwapResult / JupiterSwapResult so the routing
 * layer can pick either path without downstream changes.
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
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount
} from "@pump-fun/pump-sdk";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { getJupiterSwapExecutionDetails, getJupiterTokenDecimals } from "./jupiterSwap";
import { createBotLog } from "./logs";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

// Pump.fun bonding curves are extremely volatile — a single whale buy of 1+ SOL
// can push the price up 40-50% in the seconds between our quote and send.
// The standard 2% Jupiter slippage fails constantly with TooMuchSolRequired.
// 50% is high but matches what's observed on real whale-followed buys.
// Override per-trade with PUMPFUN_SLIPPAGE_BPS.
const DEFAULT_SLIPPAGE_BPS = 5000; // 50%
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 100_000;
const DEFAULT_COMPUTE_UNIT_LIMIT = 250_000;

export type PumpFunSwapResult = {
  tokenMint: string;
  side: "buy" | "sell";
  route: "Pump.fun";
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
  // Pump.fun-specific override wins; otherwise fall back to high default (not the
  // tight 2% Jupiter slippage which causes TooMuchSolRequired on volatile curves).
  const pumpFunOverride = Number(process.env.PUMPFUN_SLIPPAGE_BPS);
  if (Number.isFinite(pumpFunOverride) && pumpFunOverride > 0) {
    return Math.floor(pumpFunOverride);
  }
  return DEFAULT_SLIPPAGE_BPS;
}

function getSlippagePct() {
  return getSlippageBps() / 100;
}

function getPriorityFeeMicroLamports() {
  const value = Number(process.env.PUMPFUN_PRIORITY_FEE_MICRO_LAMPORTS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
}

function getComputeUnitLimit() {
  const value = Number(process.env.PUMPFUN_COMPUTE_UNIT_LIMIT);
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

export async function executePumpFunBuy(
  tokenMint: string,
  amountSol: number,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<PumpFunSwapResult> {
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const onlineSdk = new OnlinePumpSdk(connection);
    const offlineSdk = new PumpSdk();

    const mint = new PublicKey(tokenMint);
    const tokenProgram = TOKEN_PROGRAM_ID;

    const [global, feeConfig, buyState] = await Promise.all([
      onlineSdk.fetchGlobal(),
      onlineSdk.fetchFeeConfig(),
      onlineSdk.fetchBuyState(mint, wallet.publicKey, tokenProgram)
    ]);

    if (buyState.bondingCurve.complete) {
      throw new Error("Pump.fun bonding curve has graduated to PumpSwap; native buy not available");
    }

    const solLamports = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));

    // Compute target token amount for this SOL input using the SDK's pricing helper.
    const targetTokenAmount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: buyState.bondingCurve,
      amount: solLamports,
      quoteMint: buyState.bondingCurve.quoteMint
    });

    const buyIxs = await offlineSdk.buyInstructions({
      global,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: buyState.bondingCurve,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint,
      user: wallet.publicKey,
      amount: targetTokenAmount,
      solAmount: solLamports,
      slippage: getSlippagePct(),
      tokenProgram
    });

    const allIxs = [...buildComputeBudgetInstructions(), ...buyIxs];
    const { signature, signatureCount } = await sendAndConfirm(allIxs, options);

    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount
    });

    return {
      tokenMint,
      side: "buy",
      route: "Pump.fun",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "PUMPFUN_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown Pump.fun buy error",
      tokenMint,
      metadata: { side: "buy", amountSol }
    });
    throw error;
  }
}

export async function executePumpFunSell(
  tokenMint: string,
  tokenAmount: number
): Promise<PumpFunSwapResult> {
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const onlineSdk = new OnlinePumpSdk(connection);
    const offlineSdk = new PumpSdk();

    const mint = new PublicKey(tokenMint);
    const tokenProgram = TOKEN_PROGRAM_ID;

    const tokenDecimals = await getJupiterTokenDecimals(tokenMint);
    const rawTokenAmount = new BN(
      Math.max(1, Math.floor(tokenAmount * 10 ** tokenDecimals)).toString()
    );

    const [global, feeConfig, sellState] = await Promise.all([
      onlineSdk.fetchGlobal(),
      onlineSdk.fetchFeeConfig(),
      onlineSdk.fetchSellState(mint, wallet.publicKey, tokenProgram)
    ]);

    if (sellState.bondingCurve.complete) {
      throw new Error("Pump.fun bonding curve has graduated; native sell not available — use Jupiter or PumpSwap");
    }

    // SDK helper requires `mintSupply` as BN (vs null for buy).
    // We can fetch the mint's actual supply once; but the helper accepts the bonding curve's
    // tokenTotalSupply as a safe upper-bound proxy for sell math.
    const expectedSolOut = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount: rawTokenAmount
    });

    const sellIxs = await offlineSdk.sellInstructions({
      global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
      mint,
      user: wallet.publicKey,
      amount: rawTokenAmount,
      solAmount: expectedSolOut,
      slippage: getSlippagePct(),
      tokenProgram,
      mayhemMode: false
    });

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
      route: "Pump.fun",
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
      event: "PUMPFUN_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown Pump.fun sell error",
      tokenMint,
      metadata: { side: "sell", tokenAmount }
    });
    throw error;
  }
}
