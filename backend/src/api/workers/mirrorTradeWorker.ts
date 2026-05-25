import path from "path";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "../db/sqlite";
import {
  detectTraderPlatformBuys,
  detectTraderPlatformSells,
  type DetectedTraderBuy,
  type DetectedTraderSell
} from "../platforms/platformDetector";
import { executeJupiterBuy, executeJupiterSell } from "../services/jupiterSwap";
import { createBotLog } from "../services/logs";
import { getTokenMetadata } from "../services/tokenMetadata";
import { refreshWalletBalance } from "../services/walletBalance";
import { readState } from "../state/store";
import { withRpcLimit } from "../utils/rpcLimiter";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SIGNATURE_LIMIT = 20;
const FEE_RESERVE_SOL = 0.01;
const FULL_SELL_THRESHOLD = 0.95;

type DbMirrorPosition = {
  id: string;
  token_mint: string;
  token_symbol: string | null;
  mirror_trader: string;
  source_buy_signature: string | null;
  buy_tx: string | null;
  entry_price_usd: number;
  current_price_usd: number;
  token_amount: number;
  sol_spent: number;
  opened_at: string;
  status: string;
};

function getRpcEndpoint() {
  return process.env.MAINNET_ENDPOINT || process.env.RPC_ENDPOINT || "";
}

function getPollIntervalMs() {
  const value = Number(process.env.MIRROR_TRADE_POLL_MS || process.env.COPY_TRADE_POLL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function isMirrorTradingEnabled() {
  const row = db.prepare("SELECT value FROM trading_runtime WHERE key = ?").get("mirror_enabled") as
    | { value: string }
    | undefined;
  return row?.value === "true";
}

function getEnabledMirrorTraders() {
  return db
    .prepare("SELECT address, label, buy_amount_sol FROM mirror_traders WHERE enabled = 1")
    .all() as Array<{ address: string; label: string | null; buy_amount_sol: number }>;
}

function isMirrorProcessed(signature: string) {
  return Boolean(
    db.prepare("SELECT 1 FROM mirror_processed_signatures WHERE signature = ?").get(signature)
  );
}

function markMirrorProcessed(input: {
  signature: string;
  trader: string;
  tokenMint?: string;
  action: "mirror-buy" | "mirror-sell";
  status: "success" | "failed" | "skipped" | "pending";
  message?: string;
}) {
  db.prepare(`
    INSERT INTO mirror_processed_signatures (signature, trader, token_mint, action, status, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signature) DO UPDATE SET
      token_mint = excluded.token_mint,
      status = excluded.status,
      message = excluded.message
  `).run(
    input.signature,
    input.trader,
    input.tokenMint || null,
    input.action,
    input.status,
    input.message || null,
    now()
  );
}

function getMirrorPosition(tokenMint: string, mirrorTrader: string) {
  return db
    .prepare("SELECT * FROM mirror_positions WHERE token_mint = ? AND mirror_trader = ? AND status = 'open'")
    .get(tokenMint, mirrorTrader) as DbMirrorPosition | undefined;
}

function createMirrorPosition(input: {
  id: string;
  tokenMint: string;
  tokenSymbol?: string;
  mirrorTrader: string;
  sourceBuySignature?: string;
  buyTx?: string;
  entryPriceUsd: number;
  tokenAmount: number;
  solSpent: number;
  openedAt: string;
}) {
  db.prepare(`
    INSERT INTO mirror_positions (
      id, token_mint, token_symbol, mirror_trader, source_buy_signature, buy_tx,
      entry_price_usd, current_price_usd, token_amount, sol_spent, opened_at, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    input.id,
    input.tokenMint,
    input.tokenSymbol || null,
    input.mirrorTrader,
    input.sourceBuySignature || null,
    input.buyTx || null,
    input.entryPriceUsd,
    input.entryPriceUsd,
    input.tokenAmount,
    input.solSpent,
    input.openedAt,
    now(),
    now()
  );
}

function closeMirrorPosition(input: {
  positionId: string;
  sourceSellSignature?: string;
  sellTx?: string;
  exitPriceUsd: number;
  solReceived?: number;
  closeReason: string;
  closedAt: string;
}) {
  const pos = db
    .prepare("SELECT * FROM mirror_positions WHERE id = ?")
    .get(input.positionId) as DbMirrorPosition | undefined;
  if (!pos) return;

  db.prepare(`
    INSERT INTO mirror_closed_positions (
      id, token_mint, token_symbol, mirror_trader,
      source_buy_signature, source_sell_signature,
      buy_tx, sell_tx,
      entry_price_usd, exit_price_usd,
      token_amount, sol_spent, sol_received,
      close_reason, opened_at, closed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pos.id,
    pos.token_mint,
    pos.token_symbol,
    pos.mirror_trader,
    pos.source_buy_signature,
    input.sourceSellSignature || null,
    pos.buy_tx,
    input.sellTx || null,
    pos.entry_price_usd,
    input.exitPriceUsd,
    pos.token_amount,
    pos.sol_spent,
    input.solReceived || null,
    input.closeReason,
    pos.opened_at,
    input.closedAt,
    now()
  );

  db.prepare("DELETE FROM mirror_positions WHERE id = ?").run(input.positionId);
}

function reducePositionAmount(positionId: string, newTokenAmount: number) {
  db.prepare(
    "UPDATE mirror_positions SET token_amount = ?, updated_at = ? WHERE id = ?"
  ).run(newTokenAmount, now(), positionId);
}

async function handleMirrorBuy(
  buy: DetectedTraderBuy,
  traderBuyAmountSol: number
) {
  if (!isMirrorTradingEnabled()) return;

  // Check for existing open position
  const existing = getMirrorPosition(buy.tokenMint, buy.trader);
  if (existing) {
    markMirrorProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      action: "mirror-buy",
      status: "skipped",
      message: `Skipped: open mirror position already exists for ${buy.tokenMint}`
    });
    createBotLog({
      level: "warn",
      event: "MIRROR_BUY_SKIPPED_POSITION_EXISTS",
      message: `Mirror buy skipped: position already open for ${buy.tokenMint}`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature
    });
    return;
  }

  // Check wallet balance
  const state = await readState();
  const wallet = await refreshWalletBalance(state.wallet);
  if (wallet.solBalance < traderBuyAmountSol + FEE_RESERVE_SOL) {
    markMirrorProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      action: "mirror-buy",
      status: "skipped",
      message: `Skipped: insufficient balance ${wallet.solBalance.toFixed(6)} SOL`
    });
    createBotLog({
      level: "warn",
      event: "MIRROR_BUY_SKIPPED_INSUFFICIENT_SOL",
      message: `Mirror buy skipped: wallet balance ${wallet.solBalance.toFixed(6)} SOL < required ${(traderBuyAmountSol + FEE_RESERVE_SOL).toFixed(6)} SOL`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      metadata: { solBalance: wallet.solBalance, buyAmountSol: traderBuyAmountSol }
    });
    return;
  }

  // Pre-mark as pending to prevent double-processing
  markMirrorProcessed({
    signature: buy.signature,
    trader: buy.trader,
    tokenMint: buy.tokenMint,
    action: "mirror-buy",
    status: "pending",
    message: "Mirror buy in progress"
  });

  createBotLog({
    event: "MIRROR_BUY_DETECTED",
    message: `Mirror trader bought ${buy.tokenMint} on ${buy.platform}, executing mirror buy`,
    trader: buy.trader,
    tokenMint: buy.tokenMint,
    signature: buy.signature,
    metadata: {
      traderSpentSol: buy.spentSol,
      mirrorAmountSol: traderBuyAmountSol,
      platform: buy.platform
    }
  });

  try {
    const result = await executeJupiterBuy(buy.tokenMint, traderBuyAmountSol, {
      shouldSend: isMirrorTradingEnabled
    });

    const tokenAmount = result.tokenAmountDelta || 0;
    const actualSolSpent = result.actualSolChange !== undefined
      ? Math.abs(result.actualSolChange)
      : traderBuyAmountSol;
    const entryPriceUsd =
      tokenAmount > 0 ? (actualSolSpent * wallet.solPriceUsd) / tokenAmount : 0;

    const tokenMetadata = await getTokenMetadata(buy.tokenMint).catch(() => undefined);
    const positionId = randomUUID();

    createMirrorPosition({
      id: positionId,
      tokenMint: buy.tokenMint,
      tokenSymbol: tokenMetadata?.symbol || buy.tokenMint.slice(0, 6),
      mirrorTrader: buy.trader,
      sourceBuySignature: buy.signature,
      buyTx: result.signature,
      entryPriceUsd,
      tokenAmount,
      solSpent: actualSolSpent,
      openedAt: now()
    });

    markMirrorProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      action: "mirror-buy",
      status: "success",
      message: result.signature
    });

    createBotLog({
      event: "MIRROR_BUY_EXECUTED",
      message: `Mirror buy executed for ${buy.tokenMint}: ${traderBuyAmountSol} SOL via Jupiter`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: result.signature,
      metadata: {
        sourceSignature: buy.signature,
        tokenAmount,
        entryPriceUsd,
        actualSolSpent,
        platform: buy.platform
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mirror buy error";
    markMirrorProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      action: "mirror-buy",
      status: "failed",
      message
    });
    createBotLog({
      level: "error",
      event: "MIRROR_BUY_FAILED",
      message,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      metadata: { traderSpentSol: buy.spentSol, mirrorAmountSol: traderBuyAmountSol }
    });
  }
}

async function handleMirrorSell(sell: DetectedTraderSell) {
  if (!isMirrorTradingEnabled()) return;

  const position = getMirrorPosition(sell.tokenMint, sell.trader);
  if (!position) {
    // We don't have this token — nothing to mirror
    markMirrorProcessed({
      signature: sell.signature,
      trader: sell.trader,
      tokenMint: sell.tokenMint,
      action: "mirror-sell",
      status: "skipped",
      message: "No open mirror position for this token"
    });
    return;
  }

  const isFullSell = sell.sellPct >= FULL_SELL_THRESHOLD;
  const amountToSell = isFullSell
    ? position.token_amount
    : position.token_amount * sell.sellPct;

  if (amountToSell <= 0) {
    markMirrorProcessed({
      signature: sell.signature,
      trader: sell.trader,
      tokenMint: sell.tokenMint,
      action: "mirror-sell",
      status: "skipped",
      message: "Zero amount to sell"
    });
    return;
  }

  markMirrorProcessed({
    signature: sell.signature,
    trader: sell.trader,
    tokenMint: sell.tokenMint,
    action: "mirror-sell",
    status: "pending",
    message: "Mirror sell in progress"
  });

  createBotLog({
    event: "MIRROR_SELL_DETECTED",
    message: `Mirror trader sold ${(sell.sellPct * 100).toFixed(1)}% of ${sell.tokenMint}, executing mirror sell`,
    trader: sell.trader,
    tokenMint: sell.tokenMint,
    signature: sell.signature,
    metadata: {
      sellPct: sell.sellPct,
      isFullSell,
      amountToSell,
      positionId: position.id
    }
  });

  try {
    const result = await executeJupiterSell(sell.tokenMint, amountToSell);
    const solReceived = result.actualSolChange !== undefined
      ? Math.abs(result.actualSolChange)
      : result.outputSol || 0;

    const state = await readState();
    const wallet = await refreshWalletBalance(state.wallet);
    const exitPriceUsd =
      amountToSell > 0 ? (solReceived * wallet.solPriceUsd) / amountToSell : 0;

    if (isFullSell) {
      closeMirrorPosition({
        positionId: position.id,
        sourceSellSignature: sell.signature,
        sellTx: result.signature,
        exitPriceUsd,
        solReceived,
        closeReason: "mirror-sell",
        closedAt: now()
      });
    } else {
      // Partial sell
      const remaining = position.token_amount - amountToSell;
      reducePositionAmount(position.id, remaining);
    }

    markMirrorProcessed({
      signature: sell.signature,
      trader: sell.trader,
      tokenMint: sell.tokenMint,
      action: "mirror-sell",
      status: "success",
      message: result.signature
    });

    createBotLog({
      event: "MIRROR_SELL_EXECUTED",
      message: `Mirror sell executed: ${isFullSell ? "full" : `${(sell.sellPct * 100).toFixed(1)}%`} of ${sell.tokenMint}`,
      trader: sell.trader,
      tokenMint: sell.tokenMint,
      signature: result.signature,
      metadata: {
        sourceSignature: sell.signature,
        sellPct: sell.sellPct,
        isFullSell,
        amountSold: amountToSell,
        solReceived,
        exitPriceUsd
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mirror sell error";
    markMirrorProcessed({
      signature: sell.signature,
      trader: sell.trader,
      tokenMint: sell.tokenMint,
      action: "mirror-sell",
      status: "failed",
      message
    });
    createBotLog({
      level: "error",
      event: "MIRROR_SELL_FAILED",
      message,
      trader: sell.trader,
      tokenMint: sell.tokenMint,
      signature: sell.signature,
      metadata: { sellPct: sell.sellPct, amountToSell }
    });
  }
}

async function processMirrorTraderSignatures(
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
        limit: DEFAULT_SIGNATURE_LIMIT,
        until: lastSeenSignature
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "RPC error";
    createBotLog({
      level: "error",
      event: "MIRROR_RPC_FAILED",
      message,
      trader,
      metadata: { method: "getSignaturesForAddress" }
    });
    throw error;
  }

  const mirrorTrader = db
    .prepare("SELECT buy_amount_sol FROM mirror_traders WHERE address = ? AND enabled = 1")
    .get(trader) as { buy_amount_sol: number } | undefined;

  if (!mirrorTrader) {
    return signatures[signatures.length - 1]?.signature || lastSeenSignature;
  }

  // Filter to new, unprocessed, non-error signatures
  const newSignatures = signatures
    .reverse()
    .filter((s) => !s.err && !isMirrorProcessed(s.signature));

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

  // Process results sequentially to avoid buy/sell race conditions
  for (let i = 0; i < newSignatures.length; i++) {
    const result = transactions[i];
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : "RPC error";
      createBotLog({
        level: "error",
        event: "MIRROR_RPC_FAILED",
        message,
        trader,
        signature: newSignatures[i].signature,
        metadata: { method: "getParsedTransaction" }
      });
      continue;
    }

    const transaction = result.value;
    if (!transaction) continue;

    const sig = newSignatures[i].signature;

    // Process buys
    const buys = detectTraderPlatformBuys(transaction, trader, sig, wallet.solPriceUsd);
    for (const buy of buys) {
      if (!isMirrorProcessed(buy.signature)) {
        await handleMirrorBuy(buy, mirrorTrader.buy_amount_sol);
      }
    }

    // Process sells
    const sells = detectTraderPlatformSells(transaction, trader, sig);
    for (const sell of sells) {
      if (!isMirrorProcessed(sell.signature)) {
        await handleMirrorSell(sell);
      }
    }
  }

  return signatures[signatures.length - 1]?.signature || lastSeenSignature;
}

export async function startMirrorTradeWorker() {
  const endpoint = getRpcEndpoint();
  if (!endpoint) {
    throw new Error("MAINNET_ENDPOINT or RPC_ENDPOINT is required for mirror-trade worker");
  }

  const connection = new Connection(endpoint, "confirmed");
  const pollIntervalMs = getPollIntervalMs();
  const lastSeenByTrader = new Map<string, string | undefined>();

  console.log(`Mirror-trade worker started. Poll interval: ${pollIntervalMs}ms`);
  createBotLog({
    event: "MIRROR_WORKER_STARTED",
    message: `Mirror-trade worker started. Poll: ${pollIntervalMs}ms`,
    metadata: { pollIntervalMs }
  });

  while (true) {
    if (!isMirrorTradingEnabled()) {
      console.log("Mirror-trade worker stopped: mirror trading disabled");
      createBotLog({
        event: "MIRROR_WORKER_STOPPED",
        message: "Mirror-trade worker stopped: mirror trading disabled"
      });
      return;
    }

    const traders = getEnabledMirrorTraders();

    await Promise.all(
      traders.map(async (trader) => {
        try {
          // On first poll, just record the latest signature to avoid replaying history
          if (!lastSeenByTrader.has(trader.address)) {
            let latest;
            try {
              latest = await withRpcLimit(() =>
                connection.getSignaturesForAddress(
                  new PublicKey(trader.address),
                  { limit: 1 }
                )
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : "RPC error";
              createBotLog({
                level: "error",
                event: "MIRROR_RPC_FAILED",
                message,
                trader: trader.address,
                metadata: { method: "getSignaturesForAddress" }
              });
              throw error;
            }
            lastSeenByTrader.set(trader.address, latest[0]?.signature);
            return;
          }

          const lastSig = await processMirrorTraderSignatures(
            connection,
            trader.address,
            lastSeenByTrader.get(trader.address)
          );
          lastSeenByTrader.set(trader.address, lastSig);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown mirror worker error";
          console.error(
            JSON.stringify({ event: "MIRROR_TRADE_WORKER_ERROR", trader: trader.address, message })
          );
          createBotLog({
            level: "error",
            event: "MIRROR_WORKER_ERROR",
            message,
            trader: trader.address,
            metadata: { trader: trader.address }
          });
        }
      })
    );

    await sleep(pollIntervalMs);
  }
}

if (require.main === module) {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(JSON.stringify({ event: "MIRROR_WORKER_UNHANDLED_REJECTION", message }));
    createBotLog({ level: "error", event: "MIRROR_WORKER_FATAL", message });
    process.exit(1);
  });

  startMirrorTradeWorker().catch((error) => {
    const message = error instanceof Error ? error.message : "Mirror-trade worker fatal crash";
    console.error(error);
    createBotLog({
      level: "error",
      event: "MIRROR_WORKER_FATAL",
      message,
      metadata: { stack: error instanceof Error ? error.stack?.slice(0, 1000) : undefined }
    });
    process.exit(1);
  });
}
