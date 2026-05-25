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
import { createBotLog } from "../services/logs";
import { logTokenSafetyBeforeBuy } from "../services/tokenSafety";
import { isTokenBlacklisted } from "../services/tokenBlacklist";
import { getTokenMetadata } from "../services/tokenMetadata";
import { refreshWalletBalance } from "../services/walletBalance";
import { addActivePosition, readState } from "../state/store";
import { withRpcLimit } from "../utils/rpcLimiter";

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

    const result = await executeJupiterBuy(buy.tokenMint, amountSol, {
      shouldSend: isCopyTradingEnabled,
      onSignature: (signature) => {
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
      }
    });
    const tokenAmount = result.tokenAmountDelta || 0;
    // Use actual SOL spent from the transaction — not the requested amount.
    // Requested amount can be rounded/slightly off; actual amount is ground truth.
    const actualSolSpent = result.actualSolChange !== undefined ? Math.abs(result.actualSolChange) : amountSol;
    const amountUsd = actualSolSpent * wallet.solPriceUsd;
    const entryPriceUsd = tokenAmount > 0 && amountUsd > 0 ? amountUsd / tokenAmount : 0;
    const tokenMetadata = await getTokenMetadata(buy.tokenMint).catch(() => undefined);

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
        profitTier: "high"
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
      message: `Copied ${buy.platform} buy through Jupiter for ${amountSol} SOL`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: result.signature,
      metadata: {
        sourceSignature: buy.signature,
        tokenAmount,
        entryPriceUsd,
        sourcePlatform: buy.platform,
        executionRoute: "Jupiter",
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
        executionRoute: "Jupiter",
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

  // Fetch all transactions in parallel, rate-limited by RPC_MAX_CONCURRENT
  const transactions = await Promise.allSettled(
    newSignatures.map((s) =>
      withRpcLimit(() =>
        connection.getParsedTransaction(s.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        })
      )
    )
  );

  // Process results sequentially to avoid buy race conditions
  for (let i = 0; i < newSignatures.length; i++) {
    const result = transactions[i];
    if (result.status === "rejected") {
      logRpcRequestFailed({
        method: "getParsedTransaction",
        trader,
        signature: newSignatures[i].signature,
        endpoint: getRpcEndpoint(),
        error: result.reason
      });
      continue;
    }

    const transaction = result.value;
    if (!transaction) continue;

    const sig = newSignatures[i].signature;
    const unmatchedBuyLikes = detectUnmatchedTraderBuyLikes(transaction, trader, sig);
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

    const buys = detectTraderPlatformBuys(transaction, trader, sig, wallet.solPriceUsd);
    for (const buy of buys) {
      await handleDetectedBuy(buy);
    }
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

  console.log(`Copy-trade worker started. Poll interval: ${pollIntervalMs}ms`);
  console.log(`Historical signatures on startup: ${includeHistory ? "enabled" : "skipped"}`);
  console.log("Real multi-platform buy execution through Jupiter: enabled");
  createBotLog({
    event: "COPY_WORKER_STARTED",
    message: `Copy-trade worker started. Poll: ${pollIntervalMs}ms, history: ${includeHistory ? "on" : "off"}`,
    metadata: { pollIntervalMs, includeHistory }
  });

  while (true) {
    if (!isCopyTradingEnabled()) {
      console.log("Copy-trade worker stopped because copy trading is disabled");
      createBotLog({
        event: "COPY_WORKER_STOPPED",
        message: "Copy-trade worker stopped: copy trading disabled"
      });
      return;
    }

    const state = await readState();
    const traders = state.trackedTraders.filter((trader) => trader.enabled);

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
