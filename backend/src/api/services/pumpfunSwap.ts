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
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount
} from "@pump-fun/pump-sdk";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { getJupiterSwapExecutionDetails } from "./jupiterSwap";
import { createBotLog } from "./logs";
import { getActualTokenBalance } from "./tokenBalance";
import { closeTokenAccountIfEmpty } from "./ataRentRecovery";
import { getMintInfo } from "./caches/mintInfoCache";
import { getCachedBlockhash, forceBlockhashRefresh } from "./caches/blockhashCache";
import { getPumpFunGlobal, getPumpFunFeeConfig, invalidatePumpFunConfig } from "./caches/pumpFunConfigCache";
import { sendBuyViaJito } from "./jitoSender";

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

/**
 * Pump.fun mints can be Token-2022 (TokenzQdBNbLqP…) — we need the EXACT token
 * program to derive the ATA and the curve vaults correctly. mintInfoCache
 * memoises this lookup since mint owner is immutable for the mint's lifetime.
 */
async function detectTokenProgram(mint: PublicKey): Promise<PublicKey> {
  try {
    const { tokenProgram } = await getMintInfo(getRaydiumConnection(), mint);
    return tokenProgram;
  } catch {
    // Mint should always exist; if cache lookup fails entirely fall back to
    // legacy SPL to preserve old behavior rather than aborting.
    return TOKEN_PROGRAM_ID;
  }
}

// Marker the RPC returns when our pre-cached blockhash has expired between
// build and send. We catch this specific case and retry once with a fresh hash.
function isBlockhashNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes("blockhash not found") || message.includes("blockhashnotfound");
}

async function sendAndConfirm(
  instructions: TransactionInstruction[],
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
    /**
     * When true, try sending via Jito Block Engine first (with tiny tip) so the
     * tx lands in the next leader slot instead of waiting for the regular RPC
     * propagation. Use ONLY on buy paths — sells/ATA closes don't need it.
     * On Jito failure we fall through to standard sendRawTransaction.
     */
     useJito?: boolean;
     /** Mint passed through to Jito logs for traceability. */
     tokenMint?: string;
  }
): Promise<{ signature: string; signatureCount: number }> {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();

  // Cached blockhash refreshes in the background every ~8s, so this is cheap.
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

  // Jito-first path (buy only). Bundle = [tipTx, swapTx]; tip 50-200K lamports.
  // Lands in the SAME leader slot as the triggering trader tx → race-winner.
  if (options.useJito) {
    try {
      const jitoResult = await sendBuyViaJito(connection, wallet, transaction, options.tokenMint);
      signature = jitoResult.signature;
    } catch (jitoErr) {
      const msg = jitoErr instanceof Error ? jitoErr.message : String(jitoErr);
      createBotLog({
        level: "warn",
        event: "BUY_JITO_FALLBACK",
        message: `Jito bundle failed, falling back to RPC send: ${msg.slice(0, 120)}`,
        tokenMint: options.tokenMint,
        metadata: { reason: msg }
      });
      // fall through to standard send
    }
  }

  if (!signature) {
    try {
      signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });
    } catch (err) {
      // Single retry on stale blockhash — force a fresh hash and rebuild the tx.
      // Worth the extra ~100ms round-trip vs losing the snipe.
      if (!isBlockhashNotFoundError(err)) throw err;
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

export async function executePumpFunBuy(
  tokenMint: string,
  amountSol: number,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<PumpFunSwapResult> {
  // Timing instrumentation — see BUY_TIMING log below. Lets us measure where
  // the snipe pipeline spends time and verify cache benefits in production.
  const t0 = Date.now();
  let tMetadata = t0;
  let tBuild = t0;
  let tSend = t0;
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const onlineSdk = new OnlinePumpSdk(connection);
    const offlineSdk = new PumpSdk();

    const mint = new PublicKey(tokenMint);
    const tokenProgram = await detectTokenProgram(mint);

    // global + feeConfig are cached (5min TTL) — only fetchBuyState hits RPC.
    const [global, feeConfig, buyState] = await Promise.all([
      getPumpFunGlobal(onlineSdk),
      getPumpFunFeeConfig(onlineSdk),
      onlineSdk.fetchBuyState(mint, wallet.publicKey, tokenProgram)
    ]);
    tMetadata = Date.now();

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
    tBuild = Date.now();

    const allIxs = [...buildComputeBudgetInstructions(), ...buyIxs];
    // Jito disabled per user request (2026-05-27). Keep flags ready for fast
    // re-enable — uncomment the two lines below to route this buy through the
    // bundle path again. See `services/jitoSender.ts` for implementation.
    const { signature, signatureCount } = await sendAndConfirm(allIxs, {
      ...options
      // useJito: true,
      // tokenMint
    });
    tSend = Date.now();

    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "buy"
    });
    const tDone = Date.now();

    createBotLog({
      event: "BUY_TIMING",
      message: `Pump.fun buy ${tokenMint.slice(0, 8)}… total=${tDone - t0}ms`,
      tokenMint,
      signature,
      metadata: {
        platform: "Pump.fun",
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
      route: "Pump.fun",
      signature,
      tokenAmountDelta: Math.abs(execDetails.tokenDelta),
      networkFeeSol: execDetails.networkFeeSol,
      priorityFeeSol: execDetails.priorityFeeSol,
      actualSolChange: execDetails.actualSolChange
    };
  } catch (error) {
    // If SDK rejected because of stale cached global/feeConfig, drop the cache
    // so the next attempt fetches fresh. We don't auto-retry here (caller has
    // its own retry/fallback policy) but we make sure the cache doesn't keep
    // serving stale data after a failure.
    invalidatePumpFunConfig();
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

    // CRITICAL: sell the real on-chain balance, not position.tokenAmount.
    // If DB drifted (transfer fee, partial fill, airdrop) we either oversell
    // (insufficient funds → tx fails) or undersell (dust left → ATA can't close
    // → 0.002 SOL rent stuck). Reading the live balance kills both failure modes.
    const actual = await getActualTokenBalance(connection, wallet.publicKey, mint);
    const tokenProgram = actual.tokenProgram;
    const rawTokenAmount = actual.balanceRaw;

    const [global, feeConfig, sellState] = await Promise.all([
      getPumpFunGlobal(onlineSdk),
      getPumpFunFeeConfig(onlineSdk),
      onlineSdk.fetchSellState(mint, wallet.publicKey, tokenProgram)
    ]);

    if (sellState.bondingCurve.complete) {
      throw new Error("Pump.fun bonding curve has graduated; native sell not available — use Jupiter or PumpSwap");
    }

    // LaunchBlitz / "mayhem" curves use the *actual* mint supply in their fee math —
    // passing the curve's tokenTotalSupply caused Anchor error 6024 (overflow) on
    // pump/src/lib.rs:844 for these tokens. The SDK gates this on bondingCurve.isMayhemMode.
    const isMayhem = Boolean((sellState.bondingCurve as unknown as { isMayhemMode?: boolean }).isMayhemMode);
    const isCashback = Boolean((sellState.bondingCurve as unknown as { isCashbackCoin?: boolean }).isCashbackCoin);
    let mintSupplyForCalc = sellState.bondingCurve.tokenTotalSupply;
    if (isMayhem) {
      try {
        const supplyResp = await connection.getTokenSupply(mint, "confirmed");
        mintSupplyForCalc = new BN(supplyResp.value.amount);
      } catch {
        // Fall through to tokenTotalSupply if the lookup fails; the sell will then
        // fail again with the same overflow but at least we tried.
      }
    }

    const expectedSolOut = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: mintSupplyForCalc,
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
      // Must match the curve's actual mode — passing false to a mayhem curve picks the
      // wrong fee recipient PDAs and causes the program to overflow on math.
      mayhemMode: isMayhem,
      // Cashback coins require userVolumeAccumulator in remaining accounts.
      // Without it, Token-2022 transfer succeeds and Pump.fun sell can fail with
      // Anchor Overflow (0x1788) even though other wallets sell the same mint.
      cashback: isCashback
    });

    const allIxs = [...buildComputeBudgetInstructions(), ...sellIxs];
    const { signature, signatureCount } = await sendAndConfirm(allIxs, {});

    const execDetails = await getJupiterSwapExecutionDetails({
      signature,
      tokenMint,
      signatureCount,
      side: "sell"
    });

    // Reclaim ~0.00204 SOL rent now that the ATA should be empty. Fire-and-forget —
    // failure here must not abort the sell flow. closeTokenAccountIfEmpty has its
    // own logging for the expected cases (non-empty, doesn't exist, etc); this
    // outer catch only fires if the function itself rejects unexpectedly.
    closeTokenAccountIfEmpty(connection, wallet, mint).catch((error) => {
      createBotLog({
        level: "warn",
        event: "ATA_CLOSE_UNHANDLED",
        message: error instanceof Error ? error.message : "Unhandled ATA close rejection",
        tokenMint,
        metadata: { route: "Pump.fun" }
      });
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
    // Drop cached global/feeConfig in case stale config caused the failure.
    invalidatePumpFunConfig();
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
