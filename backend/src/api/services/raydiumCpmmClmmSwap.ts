/**
 * Native Raydium CPMM and CLMM buy/sell using @raydium-io/raydium-sdk-v2.
 *
 * Flow:
 *   1. Load Raydium SDK with our wallet
 *   2. Fetch pool info via Raydium API
 *   3. Build the swap transaction via high-level helpers (legacy Transaction)
 *   4. Sign, send, confirm, read execution details from tx meta
 *
 * Uses legacy Transaction (default txVersion=LEGACY) to avoid generic typing issues
 * with TxVersion.V0. Legacy is fine for these swaps — the size limit isn't an issue
 * for direct CPMM/CLMM swaps with a single hop.
 */
import path from "path";
import dotenv from "dotenv";
import BN from "bn.js";
import Decimal from "decimal.js";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction
} from "@solana/web3.js";
import {
  Raydium,
  CurveCalculator,
  PoolInfoLayout,
  type ApiV3PoolInfoStandardItemCpmm,
  type ApiV3PoolInfoConcentratedItem
} from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { getJupiterSwapExecutionDetails } from "./jupiterSwap";
import { createBotLog } from "./logs";
import { closeTokenAccountIfEmpty } from "./ataRentRecovery";
import { getActualTokenBalance } from "./tokenBalance";
import { sendBuyViaJito } from "./jitoSender";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_SLIPPAGE_BPS = 200;
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 100_000;
const DEFAULT_COMPUTE_UNIT_LIMIT = 250_000;

export type RaydiumCpmmClmmSwapResult = {
  tokenMint: string;
  side: "buy" | "sell";
  route: "Raydium-CPMM" | "Raydium-CLMM";
  signature: string;
  tokenAmountDelta?: number;
  outputSol?: number;
  networkFeeSol?: number;
  priorityFeeSol?: number;
  quotedOutAmount?: number;
  quotedOutSol?: number;
  actualSolChange?: number;
};

function getSlippagePct(): number {
  const bps = Number(process.env.JUPITER_SLIPPAGE_BPS);
  const final = Number.isFinite(bps) && bps > 0 ? Math.floor(bps) : DEFAULT_SLIPPAGE_BPS;
  return final / 10000;
}

function getPriorityFeeMicroLamports(): number {
  const value = Number(process.env.RAYDIUM_PRIORITY_FEE_MICRO_LAMPORTS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
}

function getComputeUnitLimit(): number {
  const value = Number(process.env.RAYDIUM_COMPUTE_UNIT_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_COMPUTE_UNIT_LIMIT;
}

let cachedRaydium: Raydium | null = null;
async function getRaydium(): Promise<Raydium> {
  if (cachedRaydium) return cachedRaydium;
  cachedRaydium = await Raydium.load({
    owner: getTradingWallet(),
    connection: getRaydiumConnection(),
    cluster: "mainnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed"
  });
  return cachedRaydium;
}

async function sendAndConfirm(
  signedTx: Transaction,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
    /** Buy only — Jito bundle first, RPC fallback. */
    useJito?: boolean;
    tokenMint?: string;
  }
): Promise<{ signature: string; signatureCount: number }> {
  const connection = getRaydiumConnection();
  if (options.shouldSend && !(await options.shouldSend())) {
    throw new Error("Swap aborted before send: trading was stopped");
  }
  let signature: string | null = null;
  if (options.useJito) {
    try {
      const wallet = getTradingWallet();
      const jitoResult = await sendBuyViaJito(connection, wallet, signedTx, options.tokenMint);
      signature = jitoResult.signature;
    } catch (jitoErr) {
      const msg = jitoErr instanceof Error ? jitoErr.message : String(jitoErr);
      createBotLog({
        level: "warn",
        event: "BUY_JITO_FALLBACK",
        message: `Raydium CPMM/CLMM Jito failed: ${msg.slice(0, 120)}`,
        tokenMint: options.tokenMint,
        metadata: { reason: msg, route: "Raydium-CPMM/CLMM" }
      });
    }
  }
  if (!signature) {
    signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
  }
  await options.onSignature?.(signature);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return { signature, signatureCount: signedTx.signatures.length || 1 };
}

/* ---------------------------------- CPMM ---------------------------------- */

export async function executeRaydiumCpmmBuy(
  tokenMint: string,
  amountSol: number,
  poolId: string,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<RaydiumCpmmClmmSwapResult> {
  try {
    const raydium = await getRaydium();
    const poolInfoRes = (await raydium.api.fetchPoolById({ ids: poolId })) as Array<
      ApiV3PoolInfoStandardItemCpmm
    >;
    const poolInfo = poolInfoRes?.[0];
    if (!poolInfo) throw new Error(`CPMM pool not found for id ${poolId}`);

    const rpcData = await raydium.cpmm.getRpcPoolInfo(poolId, true);
    const inputAmount = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));

    // Spending quote (SOL) for base — input goes into quote reserve, out from base
    const swapResult = CurveCalculator.swap(
      inputAmount,
      rpcData.quoteReserve,
      rpcData.baseReserve,
      rpcData.configInfo!.tradeFeeRate
    );

    const { transaction } = (await raydium.cpmm.swap({
      poolInfo,
      swapResult,
      slippage: getSlippagePct(),
      baseIn: false,
      computeBudgetConfig: {
        units: getComputeUnitLimit(),
        microLamports: getPriorityFeeMicroLamports()
      }
    })) as { transaction: Transaction };

    transaction.partialSign(getTradingWallet());
    // Jito disabled per user request — uncomment to re-enable.
    const { signature, signatureCount } = await sendAndConfirm(transaction, {
      ...options
      // useJito: true,
      // tokenMint
    });
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "buy"
    });
    // inputAmount was used for fee/slippage calc above; not needed by SDK swap params
    void inputAmount;

    return {
      tokenMint,
      side: "buy",
      route: "Raydium-CPMM",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "RAYDIUM_CPMM_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown CPMM buy error",
      tokenMint,
      metadata: { side: "buy", amountSol, poolId }
    });
    throw error;
  }
}

export async function executeRaydiumCpmmSell(
  tokenMint: string,
  tokenAmount: number,
  tokenDecimals: number,
  poolId: string
): Promise<RaydiumCpmmClmmSwapResult> {
  try {
    const raydium = await getRaydium();
    const poolInfoRes = (await raydium.api.fetchPoolById({ ids: poolId })) as Array<
      ApiV3PoolInfoStandardItemCpmm
    >;
    const poolInfo = poolInfoRes?.[0];
    if (!poolInfo) throw new Error(`CPMM pool not found for id ${poolId}`);

    const rpcData = await raydium.cpmm.getRpcPoolInfo(poolId, true);
    // CRITICAL: use the live ATA balance, not the DB tokenAmount, so we sell to a
    // clean zero and the ATA can be closed afterwards. `tokenDecimals` is kept only
    // as a fallback signal — `getActualTokenBalance` also returns decimals from chain.
    const actual = await getActualTokenBalance(
      getRaydiumConnection(),
      getTradingWallet().publicKey,
      new PublicKey(tokenMint)
    );
    const inputAmount = actual.balanceRaw;
    void tokenAmount; void tokenDecimals;

    // Selling base (meme) for quote (SOL)
    const swapResult = CurveCalculator.swap(
      inputAmount,
      rpcData.baseReserve,
      rpcData.quoteReserve,
      rpcData.configInfo!.tradeFeeRate
    );

    const { transaction } = (await raydium.cpmm.swap({
      poolInfo,
      swapResult,
      slippage: getSlippagePct(),
      baseIn: true,
      computeBudgetConfig: {
        units: getComputeUnitLimit(),
        microLamports: getPriorityFeeMicroLamports()
      }
    })) as { transaction: Transaction };

    transaction.partialSign(getTradingWallet());
    const { signature, signatureCount } = await sendAndConfirm(transaction, {});
    void inputAmount;
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "sell"
    });

    closeTokenAccountIfEmpty(
      getRaydiumConnection(),
      getTradingWallet(),
      new PublicKey(tokenMint)
    ).catch((error) => {
      createBotLog({
        level: "warn",
        event: "ATA_CLOSE_UNHANDLED",
        message: error instanceof Error ? error.message : "Unhandled ATA close rejection",
        tokenMint,
        metadata: { route: "Raydium-CPMM/CLMM" }
      });
    });

    const outputSol = execDetails.actualSolChange !== undefined ? Math.abs(execDetails.actualSolChange) : 0;
    return {
      tokenMint,
      side: "sell",
      route: "Raydium-CPMM",
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
      event: "RAYDIUM_CPMM_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown CPMM sell error",
      tokenMint,
      metadata: { side: "sell", poolId }
    });
    throw error;
  }
}

/* ---------------------------------- CLMM ---------------------------------- */

/**
 * Fetch CLMM pool's observationId by reading the on-chain pool account and decoding it.
 * The CLMM swap function requires observationId but the Raydium API V3 pool info
 * doesn't expose it — it lives in the pool's on-chain state.
 */
async function getClmmObservationId(poolId: string): Promise<PublicKey> {
  const connection = getRaydiumConnection();
  const accountInfo = await connection.getAccountInfo(new PublicKey(poolId));
  if (!accountInfo) throw new Error(`CLMM pool account not found: ${poolId}`);
  const decoded = PoolInfoLayout.decode(accountInfo.data);
  return decoded.observationId;
}

export async function executeRaydiumClmmBuy(
  tokenMint: string,
  amountSol: number,
  poolId: string,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<RaydiumCpmmClmmSwapResult> {
  try {
    const raydium = await getRaydium();
    const poolInfoRes = (await raydium.api.fetchPoolById({ ids: poolId })) as Array<
      ApiV3PoolInfoConcentratedItem
    >;
    const poolInfo = poolInfoRes?.[0];
    if (!poolInfo) throw new Error(`CLMM pool not found for id ${poolId}`);

    const observationId = await getClmmObservationId(poolId);
    const amountIn = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));
    const amountOutMin = new BN(1);

    const { transaction } = (await raydium.clmm.swap({
      poolInfo,
      inputMint: NATIVE_MINT.toBase58(),
      amountIn,
      amountOutMin,
      observationId,
      ownerInfo: { useSOLBalance: true },
      remainingAccounts: []
    })) as { transaction: Transaction };

    transaction.partialSign(getTradingWallet());
    // Jito disabled per user request — uncomment to re-enable.
    const { signature, signatureCount } = await sendAndConfirm(transaction, {
      ...options
      // useJito: true,
      // tokenMint
    });
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "buy"
    });

    return {
      tokenMint,
      side: "buy",
      route: "Raydium-CLMM",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "RAYDIUM_CLMM_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown CLMM buy error",
      tokenMint,
      metadata: { side: "buy", amountSol, poolId }
    });
    throw error;
  }
}

export async function executeRaydiumClmmSell(
  tokenMint: string,
  tokenAmount: number,
  tokenDecimals: number,
  poolId: string
): Promise<RaydiumCpmmClmmSwapResult> {
  try {
    const raydium = await getRaydium();
    const poolInfoRes = (await raydium.api.fetchPoolById({ ids: poolId })) as Array<
      ApiV3PoolInfoConcentratedItem
    >;
    const poolInfo = poolInfoRes?.[0];
    if (!poolInfo) throw new Error(`CLMM pool not found for id ${poolId}`);

    const observationId = await getClmmObservationId(poolId);
    // CRITICAL: sell live ATA balance — see CPMM sell for rationale.
    const actual = await getActualTokenBalance(
      getRaydiumConnection(),
      getTradingWallet().publicKey,
      new PublicKey(tokenMint)
    );
    const amountIn = actual.balanceRaw;
    void tokenAmount; void tokenDecimals;
    const amountOutMin = new BN(1);

    const { transaction } = (await raydium.clmm.swap({
      poolInfo,
      inputMint: tokenMint,
      amountIn,
      amountOutMin,
      observationId,
      ownerInfo: { useSOLBalance: true },
      remainingAccounts: []
    })) as { transaction: Transaction };

    transaction.partialSign(getTradingWallet());
    const { signature, signatureCount } = await sendAndConfirm(transaction, {});
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "sell"
    });

    closeTokenAccountIfEmpty(
      getRaydiumConnection(),
      getTradingWallet(),
      new PublicKey(tokenMint)
    ).catch((error) => {
      createBotLog({
        level: "warn",
        event: "ATA_CLOSE_UNHANDLED",
        message: error instanceof Error ? error.message : "Unhandled ATA close rejection",
        tokenMint,
        metadata: { route: "Raydium-CPMM/CLMM" }
      });
    });

    const outputSol = execDetails.actualSolChange !== undefined ? Math.abs(execDetails.actualSolChange) : 0;
    return {
      tokenMint,
      side: "sell",
      route: "Raydium-CLMM",
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
      event: "RAYDIUM_CLMM_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown CLMM sell error",
      tokenMint,
      metadata: { side: "sell", poolId }
    });
    throw error;
  }
}
