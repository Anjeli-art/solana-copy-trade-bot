import path from "path";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "../db/sqlite";
import {
  detectTraderPlatformBuys,
  detectUnmatchedTraderBuyLikes,
  type DetectedTraderBuy
} from "../platforms/platformDetector";
import { executeJupiterBuy } from "../services/jupiterSwap";
import { executePumpSwapBuy } from "../services/pumpswapSwap";
import { executePumpFunBuy } from "../services/pumpfunSwap";
import { executeRaydiumAmmV4Buy } from "../services/raydiumAmmV4Swap";
import { executeRaydiumCpmmBuy, executeRaydiumClmmBuy } from "../services/raydiumCpmmClmmSwap";
import { executeOrcaWhirlpoolBuy } from "../services/orcaWhirlpoolSwap";
import { createBotLog } from "../services/logs";
import { logTokenSafetyBeforeBuy } from "../services/tokenSafety";
import { isTokenBlacklisted } from "../services/tokenBlacklist";
import { getTokenMetadata } from "../services/tokenMetadata";
import { refreshWalletBalance } from "../services/walletBalance";
import { addActivePosition, readState } from "../state/store";
import { withRpcLimit } from "../utils/rpcLimiter";
import { createHeliusWebSocketManager, type HeliusWebSocketManager } from "../utils/heliusWebSocket";
import { TRANSACTION_READ_COMMITMENT } from "../utils/commitment";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_SIGNATURE_LIMIT = 20;
const FEE_RESERVE_SOL = 0.01;

function getRpcEndpoint() {
  return process.env.MAINNET_ENDPOINT || process.env.RPC_ENDPOINT || "";
}

function getPollIntervalMs() {
  const value = Number(process.env.COPY_TRADE_POLL_MS || process.env.FREE_MONITOR_POLL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function getSignatureLimit() {
  const value = Number(process.env.COPY_TRADE_SIGNATURE_LIMIT || process.env.FREE_MONITOR_SIGNATURE_LIMIT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SIGNATURE_LIMIT;
}

function shouldIncludeHistory() {
  return process.env.COPY_TRADE_INCLUDE_HISTORY === "true";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function isCopyTradingEnabled() {
  const row = db.prepare("SELECT value FROM trading_runtime WHERE key = ?").get("copy_enabled") as
    | { value: string }
    | undefined;
  return row?.value === "true";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown RPC request error";
}

function logRpcRequestFailed(input: {
  method: string;
  trader: string;
  signature?: string;
  endpoint?: string;
  error: unknown;
}) {
  createBotLog({
    level: "error",
    event: "RPC_REQUEST_FAILED",
    message: getErrorMessage(input.error),
    wallet: input.trader,
    trader: input.trader,
    signature: input.signature,
    metadata: {
      method: input.method,
      endpoint: input.endpoint,
      signature: input.signature
    }
  });
}

function isProcessed(signature: string) {
  const row = db.prepare("SELECT signature FROM processed_signatures WHERE signature = ?").get(signature);
  return Boolean(row);
}

function claimProcessedPending(input: { signature: string; trader: string; tokenMint?: string }) {
  const result = db
    .prepare(
      `
        INSERT OR IGNORE INTO processed_signatures (signature, trader, token_mint, action, status, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(input.signature, input.trader, input.tokenMint || null, "copy-buy", "pending", "Buy detected", now());

  return result.changes > 0;
}

function markProcessed(input: {
  signature: string;
  trader: string;
  tokenMint?: string;
  status: "dry-run" | "success" | "failed" | "skipped" | "pending" | "tx_sent";
  message?: string;
}) {
  db.prepare(
    `
      INSERT INTO processed_signatures (signature, trader, token_mint, action, status, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET
        token_mint = excluded.token_mint,
        status = excluded.status,
        message = excluded.message
    `
  ).run(input.signature, input.trader, input.tokenMint || null, "copy-buy", input.status, input.message || null, now());
}

function claimTokenBuy(input: { tokenMint: string; signature: string; trader: string }) {
  const savedAt = now();
  // Only retry if the previous failure was a network/connectivity error (Jupiter down).
  // Simulation failures, bad tokens, insufficient liquidity etc. should stay blocked.
  const existing = db
    .prepare("SELECT status, message FROM copy_buy_token_locks WHERE token_mint = ?")
    .get(input.tokenMint) as { status: string; message: string | null } | undefined;

  if (existing?.status === "failed") {
    const msg = (existing.message || "").toLowerCase();
    const isNetworkError = msg.includes("fetch failed") || msg.includes("network") || msg.includes("econnrefused") || msg.includes("timeout");
    if (isNetworkError) {
      db.prepare("DELETE FROM copy_buy_token_locks WHERE token_mint = ?").run(input.tokenMint);
    }
  }

  const result = db
    .prepare(
      `
        INSERT OR IGNORE INTO copy_buy_token_locks (
          token_mint, source_signature, trader, status, message, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(input.tokenMint, input.signature, input.trader, "pending", "Copy buy in progress", savedAt, savedAt);

  return result.changes > 0;
}

function updateTokenBuyLock(input: { tokenMint: string; status: "success" | "failed" | "tx_sent"; message?: string }) {
  db.prepare(
    `
      UPDATE copy_buy_token_locks
      SET status = ?, message = ?, updated_at = ?
      WHERE token_mint = ?
    `
  ).run(input.status, input.message || null, now(), input.tokenMint);
}

async function handleDetectedBuy(buy: DetectedTraderBuy) {
  if (!isCopyTradingEnabled()) {
    return;
  }

  if (!claimProcessedPending({ signature: buy.signature, trader: buy.trader, tokenMint: buy.tokenMint })) {
    return;
  }

  const state = await readState();
  const amountSol = state.settings.buyAmountSol;
  const existingPosition = state.activePositions.find((position) => position.tokenMint === buy.tokenMint);

  if (isTokenBlacklisted(buy.tokenMint)) {
    const message = `Buy skipped: token ${buy.tokenMint} is blacklisted`;
    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "skipped",
      message
    });
    createBotLog({
      level: "warn",
      event: "BUY_SKIPPED_TOKEN_BLACKLISTED",
      message,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      metadata: {
        traderSpentSol: buy.spentSol,
        platform: buy.platform
      }
    });
    return;
  }

  if (existingPosition) {
    const message = `Buy skipped: active position already exists for ${buy.tokenMint}`;
    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "skipped",
      message
    });
    createBotLog({
      level: "warn",
      event: "BUY_SKIPPED_POSITION_EXISTS",
      message,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      positionId: existingPosition.id,
      metadata: {
        existingPositionId: existingPosition.id,
        existingPositionTrader: existingPosition.sourceTrader,
        traderSpentSol: buy.spentSol,
        platform: buy.platform
      }
    });
    return;
  }

  try {
    if (!isCopyTradingEnabled()) {
      const message = "Buy skipped: copy trading was stopped before wallet check";
      markProcessed({
        signature: buy.signature,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        status: "skipped",
        message
      });
      return;
    }

    const wallet = await refreshWalletBalance(state.wallet);
    if (wallet.solBalance < amountSol + FEE_RESERVE_SOL) {
      const message = `Buy skipped: wallet balance ${wallet.solBalance.toFixed(6)} SOL is below required ${(amountSol + FEE_RESERVE_SOL).toFixed(6)} SOL`;
      markProcessed({
        signature: buy.signature,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        status: "skipped",
        message
      });
      createBotLog({
        level: "warn",
        event: "BUY_SKIPPED_INSUFFICIENT_SOL",
        message,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        signature: buy.signature,
        metadata: {
          solBalance: wallet.solBalance,
          buyAmountSol: amountSol,
          feeReserveSol: FEE_RESERVE_SOL
        }
      });
      return;
    }

    if (!claimTokenBuy({ tokenMint: buy.tokenMint, signature: buy.signature, trader: buy.trader })) {
      const message = `Buy skipped: copy buy lock already exists for ${buy.tokenMint}`;
      markProcessed({
        signature: buy.signature,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        status: "skipped",
        message
      });
      createBotLog({
        level: "warn",
        event: "BUY_SKIPPED_TOKEN_LOCKED",
        message,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        signature: buy.signature,
        metadata: {
          traderSpentSol: buy.spentSol,
          platform: buy.platform
        }
      });
      return;
    }

    createBotLog({
      event: "TRADER_BUY_DETECTED",
      message: `Tracked trader bought ${buy.tokenMint} on ${buy.platform}`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      metadata: {
        traderSpentSol: buy.spentSol,
        traderEntryPriceUsd: buy.traderEntryPriceUsd,
        copiedAmountSol: amountSol,
        platform: buy.platform,
        matchedPrograms: buy.matchedPrograms
      }
    });

    await logTokenSafetyBeforeBuy({
      tokenMint: buy.tokenMint,
      amountSol,
      trader: buy.trader,
      signature: buy.signature,
      source: "copy-trade"
    });

    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "pending",
      message: "Buy in progress"
    });

    if (!isCopyTradingEnabled()) {
      const message = "Buy skipped: copy trading was stopped before Jupiter buy";
      markProcessed({
        signature: buy.signature,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        status: "skipped",
        message
      });
      updateTokenBuyLock({
        tokenMint: buy.tokenMint,
        status: "failed",
        message
      });
      createBotLog({
        level: "warn",
        event: "BUY_SKIPPED_COPY_STOPPED",
        message,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        signature: buy.signature,
        metadata: {
          traderSpentSol: buy.spentSol,
          platform: buy.platform
        }
      });
      return;
    }

    // Route per detected venue (buy.monitorType is set by the platform detector):
    //   pumpswap         → native PumpSwap
    //   pumpfun          → native Pump.fun bonding curve
    //   raydium_amm_v4   → native Raydium AMM v4
    //   raydium_cpmm     → native Raydium CPMM
    //   raydium_clmm     → native Raydium CLMM
    //   else             → Jupiter fallback
    const useNativePumpSwap = buy.monitorType === "pumpswap" && Boolean(buy.poolAddress);
    const useNativePumpFun = buy.monitorType === "pumpfun" && Boolean(buy.poolAddress);
    const useNativeRaydium =
      buy.monitorType === "raydium_amm_v4" && Boolean(buy.poolAddress) && Boolean(buy.poolBaseVault);
    const useNativeRaydiumCpmm =
      buy.monitorType === "raydium_cpmm" && Boolean(buy.poolAddress);
    const useNativeRaydiumClmm =
      buy.monitorType === "raydium_clmm" && Boolean(buy.poolAddress);
    const useNativeOrca =
      buy.monitorType === "orca_whirlpool" && Boolean(buy.poolAddress);
    const onSignature = (signature: string) => {
      markProcessed({
        signature: buy.signature,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        status: "tx_sent",
        message: signature
      });
      updateTokenBuyLock({
        tokenMint: buy.tokenMint,
        status: "tx_sent",
        message: signature
      });
    };
    const result = useNativePumpSwap
      ? await executePumpSwapBuy(buy.tokenMint, amountSol, buy.poolAddress as string, {
          shouldSend: isCopyTradingEnabled,
          onSignature
        })
      : useNativePumpFun
        ? await executePumpFunBuy(buy.tokenMint, amountSol, {
            shouldSend: isCopyTradingEnabled,
            onSignature
          })
        : useNativeRaydium
          ? await executeRaydiumAmmV4Buy(buy.tokenMint, amountSol, buy.poolAddress as string, {
              shouldSend: isCopyTradingEnabled,
              onSignature
            })
          : useNativeRaydiumCpmm
            ? await executeRaydiumCpmmBuy(buy.tokenMint, amountSol, buy.poolAddress as string, {
                shouldSend: isCopyTradingEnabled,
                onSignature
              })
            : useNativeRaydiumClmm
              ? await executeRaydiumClmmBuy(buy.tokenMint, amountSol, buy.poolAddress as string, {
                  shouldSend: isCopyTradingEnabled,
                  onSignature
                })
              : useNativeOrca
                ? await executeOrcaWhirlpoolBuy(buy.tokenMint, amountSol, buy.poolAddress as string, {
                    shouldSend: isCopyTradingEnabled,
                    onSignature
                  })
                : await executeJupiterBuy(buy.tokenMint, amountSol, {
                    shouldSend: isCopyTradingEnabled,
                    onSignature
                  });
    const executionRoute = useNativePumpSwap
      ? "PumpSwap"
      : useNativePumpFun
        ? "Pump.fun"
        : useNativeRaydium
          ? "Raydium"
          : useNativeRaydiumCpmm
            ? "Raydium-CPMM"
            : useNativeRaydiumClmm
              ? "Raydium-CLMM"
              : useNativeOrca
                ? "Orca"
                : "Jupiter";
    const tokenAmount = result.tokenAmountDelta || 0;
    // Use actual SOL spent from the transaction — not the requested amount.
    // Requested amount can be rounded/slightly off; actual amount is ground truth.
    const actualSolSpent = result.actualSolChange !== undefined ? Math.abs(result.actualSolChange) : amountSol;
    const amountUsd = actualSolSpent * wallet.solPriceUsd;
    const entryPriceUsd = tokenAmount > 0 && amountUsd > 0 ? amountUsd / tokenAmount : 0;
    const tokenMetadata = await getTokenMetadata(buy.tokenMint).catch(() => undefined);

    // Pool / bonding-curve metadata for native WebSocket monitoring. The detector
    // already resolved the subtype into buy.monitorType, so we just trust it.
    //   pumpswap / raydium_amm_v4 / raydium_cpmm → pool id + base/quote vaults
    //   pumpfun / raydium_clmm                   → just poolAddress (no vaults)
    const monitorType = buy.monitorType ?? null;
    // Two-vault venues need both base+quote vaults saved. Whirlpool / CLMM / Pump.fun
    // are single-account (poolAddress only), no vaults to store.
    const hasTwoVaultMonitoring =
      monitorType === "pumpswap" ||
      monitorType === "raydium_amm_v4" ||
      monitorType === "raydium_cpmm";

    await addActivePosition(
      {
        id: randomUUID(),
        tokenSymbol: tokenMetadata?.symbol || buy.tokenMint.slice(0, 6),
        tokenMint: buy.tokenMint,
        tokenImage: tokenMetadata?.image,
        sourceTrader: buy.trader,
        sourceSignature: buy.signature,
        buyPlatform: buy.platform,
        buyTx: result.signature,
        entryPriceUsd,
        currentPriceUsd: entryPriceUsd,
        amountUsd,
        solSpent: actualSolSpent,
        buyNetworkFeeSol: result.networkFeeSol,
        buyPriorityFeeSol: result.priorityFeeSol,
        buyQuotedOutAmount: result.quotedOutAmount,
        buyActualSolChange: result.actualSolChange,
        tokenAmount,
        openedAt: new Date().toISOString(),
        status: "open",
        profitTier: "high",
        poolAddress: monitorType ? buy.poolAddress : undefined,
        poolBaseVault: hasTwoVaultMonitoring ? buy.poolBaseVault : undefined,
        poolQuoteVault: hasTwoVaultMonitoring ? buy.poolQuoteVault : undefined,
        poolBaseDecimals: monitorType ? tokenMetadata?.decimals : undefined,
        monitorType
      },
      wallet
    );

    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "success",
      message: result.signature
    });
    updateTokenBuyLock({
      tokenMint: buy.tokenMint,
      status: "success",
      message: result.signature
    });
    createBotLog({
      event: "COPY_BUY_EXECUTED",
      message: `Copied ${buy.platform} buy through ${executionRoute} for ${amountSol} SOL`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: result.signature,
      metadata: {
        sourceSignature: buy.signature,
        tokenAmount,
        entryPriceUsd,
        sourcePlatform: buy.platform,
        executionRoute,
        quotedOutAmount: result.quotedOutAmount,
        networkFeeSol: result.networkFeeSol,
        priorityFeeSol: result.priorityFeeSol,
        actualSolChange: result.actualSolChange
      }
    });
    console.log(
      JSON.stringify({
        event: "COPY_TRADE_BUY_EXECUTED",
        trader: buy.trader,
        sourceSignature: buy.signature,
        tokenMint: buy.tokenMint,
        amountSol,
        botSignature: result.signature,
        tokenAmount,
        platform: buy.platform,
        executionRoute,
        traderSpentSol: buy.spentSol,
        traderEntryPriceUsd: buy.traderEntryPriceUsd
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown copy trade error";
    const existingLock = db
      .prepare("SELECT status, message FROM copy_buy_token_locks WHERE token_mint = ?")
      .get(buy.tokenMint) as { status: string; message: string | null } | undefined;
    if (existingLock?.status === "tx_sent" && existingLock.message) {
      markProcessed({
        signature: buy.signature,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        status: "tx_sent",
        message: existingLock.message
      });
      createBotLog({
        level: "error",
        event: "COPY_BUY_POSITION_WRITE_FAILED",
        message: `${message}. Buy tx was already sent and will be recovered from chain.`,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        signature: existingLock.message,
        metadata: {
          sourceSignature: buy.signature,
          traderSpentSol: buy.spentSol
        }
      });
      return;
    }
    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "failed",
      message
    });
    updateTokenBuyLock({
      tokenMint: buy.tokenMint,
      status: "failed",
      message
    });
    createBotLog({
      level: "error",
      event: "COPY_BUY_FAILED",
      message,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      metadata: {
        traderSpentSol: buy.spentSol
      }
    });
    console.error(
      JSON.stringify({
        event: "COPY_TRADE_BUY_FAILED",
        trader: buy.trader,
        signature: buy.signature,
        tokenMint: buy.tokenMint,
        traderSpentSol: buy.spentSol,
        message
      })
    );
  }
}

/**
 * Result of attempting to process one trader signature.
 *
 * - `processed`: tx was fetched and trade detection ran (success or no-buy alike)
 * - `skipped`: signature was already in processed_signatures DB (idempotent skip)
 * - `not_ready`: RPC returned null at `processed` commitment — likely still
 *   propagating through the cluster. Caller should NOT advance lastSeen so the
 *   polling fallback can pick it up once it confirms.
 * - `failed`: RPC error. Same — leave lastSeen for fallback retry.
 */
type ProcessResult = "processed" | "skipped" | "not_ready" | "failed";

// Retry window for null-reads on `processed` commitment. The leader block
// usually propagates to Helius's read index within ~100-500ms. After this many
// attempts we give up and let the polling fallback retry at `confirmed`.
const PROCESSED_FETCH_RETRIES = [100, 200, 400] as const;

async function processSingleSignature(
  connection: Connection,
  trader: string,
  signature: string,
  solPriceUsd: number
): Promise<ProcessResult> {
  if (isProcessed(signature)) {
    return "skipped";
  }

  // Read the tx at confirmed: getParsedTransaction/getTransaction reject
  // `processed` at runtime. WS may notify before the transaction is readable, so
  // retry on null and leave lastSeen untouched if it is still not ready.
  let transaction;
  try {
    transaction = await withRpcLimit(() =>
      connection.getParsedTransaction(signature, {
        commitment: TRANSACTION_READ_COMMITMENT,
        maxSupportedTransactionVersion: 0
      })
    );
    for (const delayMs of PROCESSED_FETCH_RETRIES) {
      if (transaction) break;
      await sleep(delayMs);
      transaction = await withRpcLimit(() =>
        connection.getParsedTransaction(signature, {
          commitment: TRANSACTION_READ_COMMITMENT,
          maxSupportedTransactionVersion: 0
        })
      );
    }
  } catch (error) {
    logRpcRequestFailed({
      method: "getParsedTransaction",
      trader,
      signature,
      endpoint: getRpcEndpoint(),
      error
    });
    return "failed";
  }

  if (!transaction) {
    // Tx visible at WS but not yet indexed for read after ~700ms total wait.
    // Leave it for polling fallback so we don't silently lose the snipe.
    return "not_ready";
  }

  const unmatchedBuyLikes = detectUnmatchedTraderBuyLikes(transaction, trader, signature);
  for (const buyLike of unmatchedBuyLikes) {
    createBotLog({
      level: "warn",
      event: "TRADER_BUY_PLATFORM_UNMATCHED",
      message: `Tracked trader received ${buyLike.tokenMint}, but platform was not matched`,
      trader: buyLike.trader,
      tokenMint: buyLike.tokenMint,
      signature: buyLike.signature,
      metadata: {
        tokenAmount: buyLike.tokenAmount,
        spentSol: buyLike.spentSol,
        solChange: buyLike.solChange,
        wsolChange: buyLike.wsolChange,
        slot: buyLike.slot,
        blockTime: buyLike.blockTime,
        mentionedPrograms: buyLike.mentionedPrograms.slice(0, 40)
      }
    });
  }

  const buys = detectTraderPlatformBuys(transaction, trader, signature, solPriceUsd);
  for (const buy of buys) {
    await handleDetectedBuy(buy);
  }
  return "processed";
}

async function processTraderSignatures(
  connection: Connection,
  trader: string,
  lastSeenSignature?: string
) {
  const state = await readState();
  const wallet = await refreshWalletBalance(state.wallet);
  let signatures;
  try {
    signatures = await withRpcLimit(() =>
      connection.getSignaturesForAddress(new PublicKey(trader), {
        limit: getSignatureLimit(),
        until: lastSeenSignature
      })
    );
  } catch (error) {
    logRpcRequestFailed({
      method: "getSignaturesForAddress",
      trader,
      endpoint: getRpcEndpoint(),
      error
    });
    throw error;
  }

  // Filter to new, unprocessed, non-error signatures
  const newSignatures = signatures
    .reverse()
    .filter((s) => !s.err && !isProcessed(s.signature));

  // Process sequentially through the shared single-signature handler.
  // Deduplication via `isProcessed` is handled inside processSingleSignature,
  // so polling and WebSocket pipelines can safely overlap.
  for (const s of newSignatures) {
    await processSingleSignature(connection, trader, s.signature, wallet.solPriceUsd);
  }

  return signatures[signatures.length - 1]?.signature || lastSeenSignature;
}

export async function startCopyTradeWorker() {
  const endpoint = getRpcEndpoint();
  if (!endpoint) {
    throw new Error("MAINNET_ENDPOINT or RPC_ENDPOINT is required for copy-trade worker");
  }

  const connection = new Connection(endpoint, "confirmed");
  const pollIntervalMs = getPollIntervalMs();
  const includeHistory = shouldIncludeHistory();
  const lastSeenByTrader = new Map<string, string | undefined>();

  // WebSocket pipeline: push signatures the moment Helius confirms them.
  // Polling stays on as a slow fallback so disconnects / silent drops
  // don't lose buys. Deduplication is enforced by isProcessed/processed_signatures.
  const wsManager: HeliusWebSocketManager | null = createHeliusWebSocketManager();
  if (wsManager) {
    wsManager.on("connect", () => {
      console.log(JSON.stringify({ event: "COPY_WS_CONNECTED" }));
      createBotLog({ event: "COPY_WS_CONNECTED", message: "Copy WebSocket connected" });
    });
    wsManager.on("disconnect", (reason) => {
      console.log(JSON.stringify({ event: "COPY_WS_DISCONNECTED", reason }));
      createBotLog({
        level: "info",
        event: "COPY_WS_DISCONNECTED",
        message: `Copy WebSocket disconnected (${reason}); auto-reconnect in progress`,
        metadata: { reason }
      });
    });
    wsManager.on("error", (error) => {
      console.error(JSON.stringify({ event: "COPY_WS_ERROR", message: error.message }));
      createBotLog({
        level: "warn",
        event: "COPY_WS_ERROR",
        message: error.message,
        metadata: { source: "websocket" }
      });
    });
    wsManager.on("notification", async ({ trader, signature, err }) => {
      if (err) return;
      if (!isCopyTradingEnabled()) return;
      try {
        const state = await readState();
        const wallet = await refreshWalletBalance(state.wallet);
        const result = await processSingleSignature(connection, trader, signature, wallet.solPriceUsd);
        // CRITICAL: only advance lastSeen when we actually handled this signature.
        // If RPC returned null at `processed` (tx not yet indexed), we leave
        // lastSeen alone so the polling fallback re-fetches at `confirmed` and
        // picks up the buy we'd otherwise lose. Without this, switching the WS
        // subscription to `processed` would silently drop ~5-10% of snipes.
        if (result === "processed" || result === "skipped") {
          lastSeenByTrader.set(trader, signature);
        } else {
          console.warn(JSON.stringify({
            event: "COPY_WS_DEFERRED_TO_POLLING",
            trader,
            signature,
            result
          }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown copy WS handler error";
        console.error(JSON.stringify({ event: "COPY_WS_HANDLER_ERROR", trader, signature, message }));
      }
    });
    wsManager.start();
  } else {
    console.log("WEBSOCKET_ENDPOINT not set — copy-trade worker will rely on polling only");
  }

  console.log(`Copy-trade worker started. Poll interval: ${pollIntervalMs}ms (fallback). WS: ${wsManager ? "on" : "off"}`);
  console.log(`Historical signatures on startup: ${includeHistory ? "enabled" : "skipped"}`);
  console.log("Real multi-platform buy execution through Jupiter: enabled");
  createBotLog({
    event: "COPY_WORKER_STARTED",
    message: `Copy-trade worker started. Poll: ${pollIntervalMs}ms (fallback), history: ${includeHistory ? "on" : "off"}, WS: ${wsManager ? "on" : "off"}`,
    metadata: { pollIntervalMs, includeHistory, websocket: Boolean(wsManager) }
  });

  while (true) {
    if (!isCopyTradingEnabled()) {
      console.log("Copy-trade worker stopped because copy trading is disabled");
      createBotLog({
        event: "COPY_WORKER_STOPPED",
        message: "Copy-trade worker stopped: copy trading disabled"
      });
      if (wsManager) wsManager.close();
      return;
    }

    const state = await readState();
    const traders = state.trackedTraders.filter((trader) => trader.enabled);

    // Keep WS subscriptions in sync with the current enabled trader list.
    if (wsManager) {
      wsManager.syncSubscriptions(traders.map((t) => t.address)).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: "COPY_WS_SYNC_ERROR", message }));
        createBotLog({
          level: "warn",
          event: "COPY_WS_SYNC_ERROR",
          message,
          metadata: { traderCount: traders.length }
        });
      });
    }

    await Promise.all(traders.map(async (trader) => {
      try {
        if (!includeHistory && !lastSeenByTrader.has(trader.address)) {
          let latest;
          try {
            latest = await withRpcLimit(() =>
              connection.getSignaturesForAddress(new PublicKey(trader.address), { limit: 1 })
            );
          } catch (error) {
            logRpcRequestFailed({
              method: "getSignaturesForAddress",
              trader: trader.address,
              endpoint,
              error
            });
            throw error;
          }
          lastSeenByTrader.set(trader.address, latest[0]?.signature);
          return;
        }

        const lastSeenSignature = await processTraderSignatures(
          connection,
          trader.address,
          lastSeenByTrader.get(trader.address)
        );

        lastSeenByTrader.set(trader.address, lastSeenSignature);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown worker error";
        console.error(JSON.stringify({ event: "COPY_TRADE_WORKER_ERROR", trader: trader.address, message }));
        createBotLog({
          level: "error",
          event: "COPY_WORKER_ERROR",
          message,
          trader: trader.address,
          metadata: { trader: trader.address }
        });
      }
    }));

    await sleep(pollIntervalMs);
  }
}

if (require.main === module) {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(JSON.stringify({ event: "COPY_WORKER_UNHANDLED_REJECTION", message }));
    createBotLog({ level: "error", event: "COPY_WORKER_FATAL", message });
    process.exit(1);
  });

  startCopyTradeWorker().catch((error) => {
    const message = error instanceof Error ? error.message : "Copy-trade worker fatal crash";
    console.error(error);
    createBotLog({
      level: "error",
      event: "COPY_WORKER_FATAL",
      message,
      metadata: { stack: error instanceof Error ? error.stack?.slice(0, 1000) : undefined }
    });
    process.exit(1);
  });
}
