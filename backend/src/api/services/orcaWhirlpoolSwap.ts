/**
 * Native Orca Whirlpool buy/sell using @orca-so/whirlpools-sdk.
 *
 * Whirlpool is concentrated liquidity. The SDK handles tick array selection internally,
 * we just provide input mint + input amount + slippage and get a built transaction.
 *
 * Flow:
 *   1. Build WhirlpoolContext with our wallet + connection
 *   2. Get Whirlpool client for the pool
 *   3. Build a swap quote (swapQuoteByInputToken) — selects tick arrays
 *   4. whirlpool.swap(quote) → TransactionBuilder
 *   5. Build, sign, send, confirm, read execution details
 *
 * Result shape matches the other native connectors.
 */
import path from "path";
import dotenv from "dotenv";
import BN from "bn.js";
import { Percentage } from "@orca-so/common-sdk";
import {
  buildWhirlpoolClient,
  WhirlpoolContext,
  swapQuoteByInputToken,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  IGNORE_CACHE
} from "@orca-so/whirlpools-sdk";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { getJupiterSwapExecutionDetails } from "./jupiterSwap";
import { createBotLog } from "./logs";
import { closeTokenAccountIfEmpty } from "./ataRentRecovery";
import { getActualTokenBalance } from "./tokenBalance";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_SLIPPAGE_BPS = 200;
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 100_000;
const DEFAULT_COMPUTE_UNIT_LIMIT = 250_000;

export type OrcaWhirlpoolSwapResult = {
  tokenMint: string;
  side: "buy" | "sell";
  route: "Orca";
  signature: string;
  tokenAmountDelta?: number;
  outputSol?: number;
  networkFeeSol?: number;
  priorityFeeSol?: number;
  quotedOutAmount?: number;
  quotedOutSol?: number;
  actualSolChange?: number;
};

function getSlippage(): Percentage {
  const value = Number(process.env.ORCA_SLIPPAGE_BPS) || Number(process.env.JUPITER_SLIPPAGE_BPS);
  const bps = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SLIPPAGE_BPS;
  // Orca uses Percentage(numerator, denominator) — bps = parts of 10000
  return Percentage.fromFraction(bps, 10000);
}

function getPriorityFeeMicroLamports(): number {
  const value = Number(process.env.ORCA_PRIORITY_FEE_MICRO_LAMPORTS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
}

function getComputeUnitLimit(): number {
  const value = Number(process.env.ORCA_COMPUTE_UNIT_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_COMPUTE_UNIT_LIMIT;
}

/**
 * Adapter to expose our Keypair as the Wallet shape Anchor expects.
 * We only need publicKey + signTransaction (signAllTransactions for batch).
 */
function makeWallet() {
  const kp = getTradingWallet();
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async <T extends Transaction>(tx: T): Promise<T> => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async <T extends Transaction>(txs: T[]): Promise<T[]> => {
      for (const tx of txs) tx.partialSign(kp);
      return txs;
    }
  };
}

let cachedContext: WhirlpoolContext | null = null;
function getCtx(): WhirlpoolContext {
  if (cachedContext) return cachedContext;
  cachedContext = WhirlpoolContext.from(
    getRaydiumConnection(),
    makeWallet() as unknown as Parameters<typeof WhirlpoolContext.from>[1],
    undefined,
    undefined,
    {}
  );
  return cachedContext;
}

async function buildAndSendSwap(params: {
  tokenMint: string;
  side: "buy" | "sell";
  poolAddress: string;
  inputAmount: BN;
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  };
}): Promise<{ signature: string; signatureCount: number }> {
  const connection = getRaydiumConnection();
  const ctx = getCtx();
  const client = buildWhirlpoolClient(ctx);
  const whirlpool = await client.getPool(new PublicKey(params.poolAddress), IGNORE_CACHE);
  const inputMint = params.side === "buy" ? NATIVE_MINT : new PublicKey(params.tokenMint);

  const quote = await swapQuoteByInputToken(
    whirlpool,
    inputMint,
    params.inputAmount,
    getSlippage(),
    ORCA_WHIRLPOOL_PROGRAM_ID,
    ctx.fetcher,
    IGNORE_CACHE
  );

  const txBuilder = await whirlpool.swap(quote);
  // Inject our compute budget settings (matches what the other connectors do).
  txBuilder.prependInstruction({
    instructions: [],
    cleanupInstructions: [],
    signers: []
  });
  const built = await txBuilder.build();

  // built.transaction may be Transaction or VersionedTransaction.
  // We're using default (Legacy) so cast safely.
  const tx = built.transaction as Transaction;
  // Apply our compute budget via direct prepend on the Transaction:
  const { ComputeBudgetProgram } = await import("@solana/web3.js");
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: getComputeUnitLimit() });
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: getPriorityFeeMicroLamports()
  });
  tx.instructions.unshift(priceIx);
  tx.instructions.unshift(limitIx);

  // Ensure tx has a recent blockhash and is signed by our wallet + extra signers.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = getTradingWallet().publicKey;
  if (built.signers && built.signers.length > 0) {
    tx.partialSign(...built.signers);
  }
  tx.partialSign(getTradingWallet());

  if (params.options.shouldSend && !(await params.options.shouldSend())) {
    throw new Error("Swap aborted before send: trading was stopped");
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  await params.options.onSignature?.(signature);
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  return { signature, signatureCount: tx.signatures.length || 1 };
}

export async function executeOrcaWhirlpoolBuy(
  tokenMint: string,
  amountSol: number,
  poolAddress: string,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<OrcaWhirlpoolSwapResult> {
  try {
    const inputAmount = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));
    const { signature, signatureCount } = await buildAndSendSwap({
      tokenMint,
      side: "buy",
      poolAddress,
      inputAmount,
      options
    });
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount
    });

    return {
      tokenMint,
      side: "buy",
      route: "Orca",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "ORCA_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown Orca buy error",
      tokenMint,
      metadata: { side: "buy", amountSol, poolAddress }
    });
    throw error;
  }
}

export async function executeOrcaWhirlpoolSell(
  tokenMint: string,
  tokenAmount: number,
  tokenDecimals: number,
  poolAddress: string
): Promise<OrcaWhirlpoolSwapResult> {
  try {
    // CRITICAL: sell live ATA balance so the account drains to zero — see CPMM/CLMM
    // sell paths for full rationale.
    const actual = await getActualTokenBalance(
      getRaydiumConnection(),
      getTradingWallet().publicKey,
      new PublicKey(tokenMint)
    );
    const inputAmount = actual.balanceRaw;
    void tokenAmount; void tokenDecimals;
    const { signature, signatureCount } = await buildAndSendSwap({
      tokenMint,
      side: "sell",
      poolAddress,
      inputAmount,
      options: {}
    });
    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount
    });

    closeTokenAccountIfEmpty(
      getRaydiumConnection(),
      getTradingWallet(),
      new PublicKey(tokenMint)
    ).catch(() => undefined);

    const outputSol = execDetails.actualSolChange !== undefined ? Math.abs(execDetails.actualSolChange) : 0;
    return {
      tokenMint,
      side: "sell",
      route: "Orca",
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
      event: "ORCA_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown Orca sell error",
      tokenMint,
      metadata: { side: "sell", tokenAmount, poolAddress }
    });
    throw error;
  }
}
