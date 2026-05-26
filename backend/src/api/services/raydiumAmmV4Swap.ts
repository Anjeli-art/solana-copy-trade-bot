/**
 * Native Raydium AMM v4 buy/sell using the existing buildRaydiumSwapTransaction logic
 * already implemented in raydiumSwap.ts (via @raydium-io/raydium-sdk).
 *
 * This file is a thin compatibility wrapper: it gives the existing Raydium swap
 * routines the same option/result surface as executeJupiterBuy / executePumpSwapBuy
 * so the routing layer in workers can pick any of these paths uniformly.
 *
 * Differences from the underlying executeRaydiumBuy/Sell:
 *   - reads actual SOL change, fees, and token delta from confirmed tx meta
 *     (the old version diffed wallet balance, which races against concurrent buys)
 *   - supports shouldSend / onSignature callbacks for state machine integration
 */
import path from "path";
import dotenv from "dotenv";
import { getRaydiumConnection, getTradingWallet, formatAmmKeysById } from "./raydiumSwap";
import { getJupiterSwapExecutionDetails } from "./jupiterSwap";
import { createBotLog } from "./logs";
import { closeTokenAccountIfEmpty } from "./ataRentRecovery";
import { getActualTokenBalance } from "./tokenBalance";

// Re-export the underlying builder so we can drive it manually with shouldSend / onSignature.
// The original executeRaydiumBuy/Sell do send+confirm internally without those hooks.
import { Liquidity, Percent, Token, TokenAmount, TOKEN_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT
} from "@solana/spl-token";
import { BN } from "@project-serum/anchor";
import { Decimal } from "decimal.js";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 100_000;
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

export type RaydiumAmmV4SwapResult = {
  tokenMint: string;
  side: "buy" | "sell";
  route: "Raydium";
  signature: string;
  tokenAmountDelta?: number;
  outputSol?: number;
  networkFeeSol?: number;
  priorityFeeSol?: number;
  quotedOutAmount?: number;
  quotedOutSol?: number;
  actualSolChange?: number;
};

function getPriorityFeeMicroLamports() {
  const value = Number(process.env.RAYDIUM_PRIORITY_FEE_MICRO_LAMPORTS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
}

function getComputeUnitLimit() {
  const value = Number(process.env.RAYDIUM_COMPUTE_UNIT_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_COMPUTE_UNIT_LIMIT;
}

async function getTokenDecimals(mint: PublicKey): Promise<number> {
  const connection = getRaydiumConnection();
  const account = await connection.getAccountInfo(mint);
  if (!account) throw new Error(`Token mint not found: ${mint.toBase58()}`);
  // SPL Mint layout: decimals at byte 44
  return account.data[44];
}

/**
 * Build the v4 swap transaction directly against a known pool id, with our priority fee
 * settings and skip-on-shouldSend semantics. Returns a signed VersionedTransaction
 * ready to be sent.
 */
async function buildSwap(params: {
  side: "buy" | "sell";
  tokenMint: string;
  /** For buy: SOL amount (UI). For sell: ignored if `rawAmount` is provided. */
  amount: number;
  /**
   * Sell path uses this — the exact raw on-chain ATA balance read at the call site.
   * Skips the ui→raw conversion (which can round-off by 1 unit and leave dust).
   */
  rawAmount?: BN;
  poolId: string;
}): Promise<{ transaction: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  const tokenMint = new PublicKey(params.tokenMint);
  const tokenDecimals = await getTokenDecimals(tokenMint);

  // Fetch the full AMM keys (markets, vaults, etc.) for this pool. Re-uses the helper
  // already in raydiumSwap.ts that decodes the LIQUIDITY_STATE_LAYOUT_V4 from chain.
  const poolKeys = await formatAmmKeysById(connection, new PublicKey(params.poolId));

  const tokenAta = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const token = new Token(TOKEN_PROGRAM_ID, tokenMint, tokenDecimals);
  const wsol = Token.WSOL;
  const inputToken = params.side === "buy" ? wsol : token;
  const outputToken = params.side === "buy" ? token : wsol;
  const rawIn = params.rawAmount
    ?? new BN(new Decimal(params.amount).mul(10 ** inputToken.decimals).toFixed(0));
  const amountIn = new TokenAmount(inputToken, rawIn);

  const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });
  const { minAmountOut } = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut: outputToken,
    slippage: new Percent(params.side === "buy" ? 3 : 5, 100)
  });

  const { innerTransaction } = await Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys,
      userKeys: {
        tokenAccountIn: params.side === "buy" ? wsolAta : tokenAta,
        tokenAccountOut: params.side === "buy" ? tokenAta : wsolAta,
        owner: wallet.publicKey
      },
      amountIn: amountIn.raw,
      minAmountOut: minAmountOut.raw
    },
    poolKeys.version
  );

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: getComputeUnitLimit() }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: getPriorityFeeMicroLamports() }),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      wsolAta,
      wallet.publicKey,
      NATIVE_MINT
    ),
    ...(params.side === "buy"
      ? [
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: wsolAta,
            lamports: Math.ceil(params.amount * LAMPORTS_PER_SOL)
          }),
          createSyncNativeInstruction(wsolAta),
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            tokenAta,
            wallet.publicKey,
            tokenMint
          )
        ]
      : []),
    ...innerTransaction.instructions,
    createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey)
  ];
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([wallet, ...innerTransaction.signers]);

  return {
    transaction,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
  };
}

export async function executeRaydiumAmmV4Buy(
  tokenMint: string,
  amountSol: number,
  poolId: string,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<RaydiumAmmV4SwapResult> {
  try {
    const connection = getRaydiumConnection();
    const built = await buildSwap({ side: "buy", tokenMint, amount: amountSol, poolId });

    if (options.shouldSend && !(await options.shouldSend())) {
      throw new Error("Swap aborted before send: trading was stopped");
    }
    const signature = await connection.sendRawTransaction(built.transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
    await options.onSignature?.(signature);
    await connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      "confirmed"
    );

    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount: built.transaction.signatures.length || 1
    });

    return {
      tokenMint,
      side: "buy",
      route: "Raydium",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "RAYDIUM_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown Raydium buy error",
      tokenMint,
      metadata: { side: "buy", amountSol, poolId }
    });
    throw error;
  }
}

export async function executeRaydiumAmmV4Sell(
  tokenMint: string,
  tokenAmount: number,
  poolId: string
): Promise<RaydiumAmmV4SwapResult> {
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    // CRITICAL: sell live on-chain balance (raw BN), not position.tokenAmount.
    // Prevents dust → ATA stays open → rent leak.
    const actual = await getActualTokenBalance(connection, wallet.publicKey, new PublicKey(tokenMint));
    const built = await buildSwap({
      side: "sell",
      tokenMint,
      amount: tokenAmount, // unused when rawAmount is set, kept for log clarity
      rawAmount: actual.balanceRaw,
      poolId
    });
    const signature = await connection.sendRawTransaction(built.transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
    await connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      "confirmed"
    );

    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount: built.transaction.signatures.length || 1
    });

    closeTokenAccountIfEmpty(connection, wallet, new PublicKey(tokenMint)).catch(
      () => undefined
    );

    const outputSol = execDetails.actualSolChange !== undefined ? Math.abs(execDetails.actualSolChange) : 0;
    return {
      tokenMint,
      side: "sell",
      route: "Raydium",
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
      event: "RAYDIUM_SWAP_FAILED",
      message: error instanceof Error ? error.message : "Unknown Raydium sell error",
      tokenMint,
      metadata: { side: "sell", tokenAmount, poolId }
    });
    throw error;
  }
}
