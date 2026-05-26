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
import { executePumpSwapBuy, executePumpSwapSell } from "../services/pumpswapSwap";
import { executePumpFunBuy, executePumpFunSell } from "../services/pumpfunSwap";
import { executeRaydiumAmmV4Buy, executeRaydiumAmmV4Sell } from "../services/raydiumAmmV4Swap";
import {
  executeRaydiumCpmmBuy,
  executeRaydiumCpmmSell,
  executeRaydiumClmmBuy,
  executeRaydiumClmmSell
} from "../services/raydiumCpmmClmmSwap";
import { createBotLog } from "../services/logs";
import { getTokenMetadata } from "../services/tokenMetadata";
import { refreshWalletBalance } from "../services/walletBalance";
import { readState } from "../state/store";
import { withRpcLimit } from "../utils/rpcLimiter";
import { createHeliusWebSocketManager, type HeliusWebSocketManager } from "../utils/heliusWebSocket";
import BN from "bn.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { decodeTokenAccountAmount, getConstantProductOutputRaw } from "../services/pumpswapPool";
import {
  decodeBondingCurveFromBase64,
  pumpFunSellSolFromTokens
} from "../services/pumpfunBondingCurve";
import {
  decodeClmmPoolFromBase64,
  clmmSellQuoteSol,
  type ClmmPoolDecoded
} from "../services/raydiumClmmPool";
import type { BondingCurve } from "@pump-fun/pump-sdk";

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
  // Native PumpSwap routing metadata (populated for PumpSwap mirror positions).
  buy_platform?: string | null;
  pool_address?: string | null;
  pool_base_vault?: string | null;
  pool_quote_vault?: string | null;
  pool_base_decimals?: number | null;
  monitor_type?: string | null;
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
  buyPlatform?: string;
  poolAddress?: string;
  poolBaseVault?: string;
  poolQuoteVault?: string;
  poolBaseDecimals?: number;
  monitorType?:
    | "pumpswap"
    | "pumpfun"
    | "raydium_amm_v4"
    | "raydium_cpmm"
    | "raydium_clmm"
    | null;
}) {
  db.prepare(`
    INSERT INTO mirror_positions (
      id, token_mint, token_symbol, mirror_trader, source_buy_signature, buy_tx,
      entry_price_usd, current_price_usd, token_amount, sol_spent, opened_at, status,
      buy_platform, pool_address, pool_base_vault, pool_quote_vault, pool_base_decimals, monitor_type,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.buyPlatform || null,
    input.poolAddress || null,
    input.poolBaseVault || null,
    input.poolQuoteVault || null,
    input.poolBaseDecimals ?? null,
    input.monitorType || null,
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
  // Where the sell actually executed — surfaces in the UI close-meta pill.
  exitPlatform?: string | null;
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
      close_reason, buy_platform, exit_platform,
      opened_at, closed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    pos.buy_platform || null,
    input.exitPlatform || null,
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
    // Route mirror buy by detector-resolved subtype.
    const useNativePumpSwap = buy.monitorType === "pumpswap" && Boolean(buy.poolAddress);
    const useNativePumpFun = buy.monitorType === "pumpfun" && Boolean(buy.poolAddress);
    const useNativeRaydium =
      buy.monitorType === "raydium_amm_v4" && Boolean(buy.poolAddress) && Boolean(buy.poolBaseVault);
    const useNativeRaydiumCpmm =
      buy.monitorType === "raydium_cpmm" && Boolean(buy.poolAddress);
    const useNativeRaydiumClmm =
      buy.monitorType === "raydium_clmm" && Boolean(buy.poolAddress);
    const result = useNativePumpSwap
      ? await executePumpSwapBuy(buy.tokenMint, traderBuyAmountSol, buy.poolAddress as string, {
          shouldSend: isMirrorTradingEnabled
        })
      : useNativePumpFun
        ? await executePumpFunBuy(buy.tokenMint, traderBuyAmountSol, {
            shouldSend: isMirrorTradingEnabled
          })
        : useNativeRaydium
          ? await executeRaydiumAmmV4Buy(buy.tokenMint, traderBuyAmountSol, buy.poolAddress as string, {
              shouldSend: isMirrorTradingEnabled
            })
          : useNativeRaydiumCpmm
            ? await executeRaydiumCpmmBuy(buy.tokenMint, traderBuyAmountSol, buy.poolAddress as string, {
                shouldSend: isMirrorTradingEnabled
              })
            : useNativeRaydiumClmm
              ? await executeRaydiumClmmBuy(buy.tokenMint, traderBuyAmountSol, buy.poolAddress as string, {
                  shouldSend: isMirrorTradingEnabled
                })
              : await executeJupiterBuy(buy.tokenMint, traderBuyAmountSol, {
                  shouldSend: isMirrorTradingEnabled
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
              : "Jupiter";

    const tokenAmount = result.tokenAmountDelta || 0;
    const actualSolSpent = result.actualSolChange !== undefined
      ? Math.abs(result.actualSolChange)
      : traderBuyAmountSol;
    const entryPriceUsd =
      tokenAmount > 0 ? (actualSolSpent * wallet.solPriceUsd) / tokenAmount : 0;

    const tokenMetadata = await getTokenMetadata(buy.tokenMint).catch(() => undefined);
    const positionId = randomUUID();
    const monitorType = buy.monitorType ?? null;
    const hasTwoVaultMonitoring =
      monitorType === "pumpswap" ||
      monitorType === "raydium_amm_v4" ||
      monitorType === "raydium_cpmm";

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
      openedAt: now(),
      buyPlatform: buy.platform,
      poolAddress: monitorType ? buy.poolAddress : undefined,
      poolBaseVault: hasTwoVaultMonitoring ? buy.poolBaseVault : undefined,
      poolQuoteVault: hasTwoVaultMonitoring ? buy.poolQuoteVault : undefined,
      poolBaseDecimals: monitorType ? tokenMetadata?.decimals : undefined,
      monitorType
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
      message: `Mirror buy executed for ${buy.tokenMint}: ${traderBuyAmountSol} SOL via ${executionRoute}`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: result.signature,
      metadata: {
        sourceSignature: buy.signature,
        tokenAmount,
        entryPriceUsd,
        actualSolSpent,
        platform: buy.platform,
        executionRoute
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
    // Route mirror sell by the monitor_type we stored at mirror-buy time.
    const useNativePumpSwap =
      position.monitor_type === "pumpswap" && Boolean(position.pool_address);
    const useNativePumpFun = position.monitor_type === "pumpfun";
    const useNativeRaydium =
      position.monitor_type === "raydium_amm_v4" && Boolean(position.pool_address);
    const useNativeRaydiumCpmm =
      position.monitor_type === "raydium_cpmm" && Boolean(position.pool_address);
    const useNativeRaydiumClmm =
      position.monitor_type === "raydium_clmm" && Boolean(position.pool_address);
    // CPMM/CLMM native sells need token decimals — read from pool record (we saved it).
    const tokenDecimals = position.pool_base_decimals ?? 0;
    const result = useNativePumpSwap
      ? await executePumpSwapSell(sell.tokenMint, amountToSell, position.pool_address as string)
      : useNativePumpFun
        ? await executePumpFunSell(sell.tokenMint, amountToSell)
        : useNativeRaydium
          ? await executeRaydiumAmmV4Sell(sell.tokenMint, amountToSell, position.pool_address as string)
          : useNativeRaydiumCpmm
            ? await executeRaydiumCpmmSell(
                sell.tokenMint,
                amountToSell,
                tokenDecimals,
                position.pool_address as string
              )
            : useNativeRaydiumClmm
              ? await executeRaydiumClmmSell(
                  sell.tokenMint,
                  amountToSell,
                  tokenDecimals,
                  position.pool_address as string
                )
              : await executeJupiterSell(sell.tokenMint, amountToSell);
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
        exitPlatform: useNativePumpSwap
          ? "PumpSwap"
          : useNativePumpFun
            ? "Pump.fun"
            : useNativeRaydium
              ? "Raydium"
              : useNativeRaydiumCpmm
                ? "Raydium-CPMM"
                : useNativeRaydiumClmm
                  ? "Raydium-CLMM"
                  : "Jupiter",
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

  for (const s of newSignatures) {
    await processSingleMirrorSignature(
      connection,
      trader,
      s.signature,
      mirrorTrader.buy_amount_sol,
      wallet.solPriceUsd
    );
  }

  return signatures[signatures.length - 1]?.signature || lastSeenSignature;
}

async function processSingleMirrorSignature(
  connection: Connection,
  trader: string,
  signature: string,
  buyAmountSol: number,
  solPriceUsd: number
) {
  if (isMirrorProcessed(signature)) {
    return;
  }

  let transaction;
  try {
    transaction = await withRpcLimit(() =>
      connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "RPC error";
    createBotLog({
      level: "error",
      event: "MIRROR_RPC_FAILED",
      message,
      trader,
      signature,
      metadata: { method: "getParsedTransaction" }
    });
    return;
  }

  if (!transaction) {
    return;
  }

  // Process buys
  const buys = detectTraderPlatformBuys(transaction, trader, signature, solPriceUsd);
  for (const buy of buys) {
    if (!isMirrorProcessed(buy.signature)) {
      await handleMirrorBuy(buy, buyAmountSol);
    }
  }

  // Process sells
  const sells = detectTraderPlatformSells(transaction, trader, signature);
  for (const sell of sells) {
    if (!isMirrorProcessed(sell.signature)) {
      await handleMirrorSell(sell);
    }
  }
}

/**
 * Compute a sell quote (UI SOL) for an open mirror position from cached pool data.
 * Mirror positions don't have a profit watcher to drive their price — this helper
 * is used to update mirror_positions.current_price_usd from WS account pushes so the
 * Mirror UI can show real-time PnL %.
 *
 * Mirrors the math in profitWatcherWorker.ts (same fee/decoder rules).
 */
function mirrorQuoteFromCache(
  pos: DbMirrorPosition,
  vaultAmounts: Map<string, bigint>,
  bondingCurveCache: Map<string, BondingCurve>,
  clmmPoolCache: Map<string, ClmmPoolDecoded>
): number {
  if (pos.monitor_type === "raydium_clmm") {
    if (!pos.pool_address) return 0;
    const pool = clmmPoolCache.get(pos.pool_address);
    if (!pool) return 0;
    return clmmSellQuoteSol(pool, pos.token_mint, pos.token_amount, 25);
  }
  if (pos.monitor_type === "pumpfun") {
    if (!pos.pool_address) return 0;
    if (pos.pool_base_decimals == null) return 0;
    const curve = bondingCurveCache.get(pos.pool_address);
    if (!curve || curve.complete) return 0;
    const rawAmount = new BN(
      Math.max(0, Math.floor(pos.token_amount * 10 ** pos.pool_base_decimals))
    );
    const outLamports = pumpFunSellSolFromTokens(
      curve.virtualTokenReserves,
      curve.virtualQuoteReserves,
      rawAmount,
      100
    );
    return Number(outLamports) / LAMPORTS_PER_SOL;
  }
  // pumpswap / raydium_amm_v4 / raydium_cpmm → two-vault constant product
  if (!pos.pool_base_vault || !pos.pool_quote_vault) return 0;
  if (pos.pool_base_decimals == null) return 0;
  const baseAmount = vaultAmounts.get(pos.pool_base_vault);
  const quoteAmount = vaultAmounts.get(pos.pool_quote_vault);
  if (baseAmount === undefined || quoteAmount === undefined) return 0;
  if (baseAmount <= 0n || quoteAmount <= 0n) return 0;
  const rawAmount = BigInt(
    Math.max(0, Math.floor(pos.token_amount * 10 ** pos.pool_base_decimals))
  );
  if (rawAmount <= 0n) return 0;
  const feeBps =
    pos.monitor_type === "raydium_amm_v4" || pos.monitor_type === "raydium_cpmm" ? 25 : 30;
  const outRaw = getConstantProductOutputRaw(baseAmount, quoteAmount, rawAmount, feeBps);
  return Number(outRaw) / LAMPORTS_PER_SOL;
}

function updateMirrorPositionPriceInDb(positionId: string, currentPriceUsd: number) {
  db.prepare(
    "UPDATE mirror_positions SET current_price_usd = ?, updated_at = ? WHERE id = ? AND status = 'open'"
  ).run(currentPriceUsd, now(), positionId);
}

export async function startMirrorTradeWorker() {
  const endpoint = getRpcEndpoint();
  if (!endpoint) {
    throw new Error("MAINNET_ENDPOINT or RPC_ENDPOINT is required for mirror-trade worker");
  }

  const connection = new Connection(endpoint, "confirmed");
  const pollIntervalMs = getPollIntervalMs();
  const lastSeenByTrader = new Map<string, string | undefined>();

  // Price monitoring state for open mirror positions. Same shape as profit watcher.
  const vaultAmounts = new Map<string, bigint>();
  const bondingCurveCache = new Map<string, BondingCurve>();
  const clmmPoolCache = new Map<string, ClmmPoolDecoded>();
  const subscribedAccounts = new Set<string>();
  const positionsByAccount = new Map<string, Set<string>>();
  const accountKind = new Map<string, "spltoken" | "bonding" | "clmm_pool">();

  const updatePriceForAccount = async (account: string) => {
    const positionIds = positionsByAccount.get(account);
    if (!positionIds) return;
    for (const positionId of positionIds) {
      try {
        const pos = db
          .prepare("SELECT * FROM mirror_positions WHERE id = ? AND status = 'open'")
          .get(positionId) as DbMirrorPosition | undefined;
        if (!pos) continue;
        const quotedOutSol = mirrorQuoteFromCache(pos, vaultAmounts, bondingCurveCache, clmmPoolCache);
        if (quotedOutSol <= 0) continue;
        const state = await readState();
        const wallet = await refreshWalletBalance(state.wallet);
        if (pos.token_amount <= 0 || wallet.solPriceUsd <= 0) continue;
        const priceUsd = (quotedOutSol * wallet.solPriceUsd) / pos.token_amount;
        updateMirrorPositionPriceInDb(positionId, priceUsd);
      } catch {
        // ignore — next push will retry
      }
    }
  };

  // WebSocket pipeline for mirror traders. Polling stays as fallback.
  const wsManager: HeliusWebSocketManager | null = createHeliusWebSocketManager();
  if (wsManager) {
    wsManager.on("connect", () => {
      console.log(JSON.stringify({ event: "MIRROR_WS_CONNECTED" }));
      createBotLog({ event: "MIRROR_WS_CONNECTED", message: "Mirror WebSocket connected" });
    });
    wsManager.on("disconnect", (reason) => {
      console.log(JSON.stringify({ event: "MIRROR_WS_DISCONNECTED", reason }));
      createBotLog({
        level: "info",
        event: "MIRROR_WS_DISCONNECTED",
        message: `Mirror WebSocket disconnected (${reason}); auto-reconnect in progress`,
        metadata: { reason }
      });
    });
    wsManager.on("error", (error) => {
      console.error(JSON.stringify({ event: "MIRROR_WS_ERROR", message: error.message }));
      createBotLog({
        level: "warn",
        event: "MIRROR_WS_ERROR",
        message: error.message,
        metadata: { source: "websocket" }
      });
    });
    wsManager.on("notification", async ({ trader, signature, err }) => {
      if (err) return;
      if (!isMirrorTradingEnabled()) return;
      try {
        const mirrorTrader = db
          .prepare("SELECT buy_amount_sol FROM mirror_traders WHERE address = ? AND enabled = 1")
          .get(trader) as { buy_amount_sol: number } | undefined;
        if (!mirrorTrader) return;
        const state = await readState();
        const wallet = await refreshWalletBalance(state.wallet);
        await processSingleMirrorSignature(
          connection,
          trader,
          signature,
          mirrorTrader.buy_amount_sol,
          wallet.solPriceUsd
        );
        lastSeenByTrader.set(trader, signature);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown mirror WS handler error";
        console.error(JSON.stringify({ event: "MIRROR_WS_HANDLER_ERROR", trader, signature, message }));
      }
    });
    // Pool account pushes → recompute price and persist on mirror_positions so the UI
    // can show live PnL % for mirror trades (mirror has no profit watcher of its own).
    wsManager.on("accountNotification", ({ account, dataBase64 }) => {
      const kind = accountKind.get(account);
      try {
        if (kind === "bonding") {
          bondingCurveCache.set(account, decodeBondingCurveFromBase64(dataBase64));
        } else if (kind === "clmm_pool") {
          clmmPoolCache.set(account, decodeClmmPoolFromBase64(dataBase64));
        } else {
          vaultAmounts.set(account, decodeTokenAccountAmount(dataBase64));
        }
      } catch {
        return;
      }
      updatePriceForAccount(account).catch(() => undefined);
    });
    wsManager.start();
  } else {
    console.log("WEBSOCKET_ENDPOINT not set — mirror-trade worker will rely on polling only");
  }

  console.log(`Mirror-trade worker started. Poll interval: ${pollIntervalMs}ms (fallback). WS: ${wsManager ? "on" : "off"}`);
  createBotLog({
    event: "MIRROR_WORKER_STARTED",
    message: `Mirror-trade worker started. Poll: ${pollIntervalMs}ms (fallback), WS: ${wsManager ? "on" : "off"}`,
    metadata: { pollIntervalMs, websocket: Boolean(wsManager) }
  });

  while (true) {
    if (!isMirrorTradingEnabled()) {
      console.log("Mirror-trade worker stopped: mirror trading disabled");
      createBotLog({
        event: "MIRROR_WORKER_STOPPED",
        message: "Mirror-trade worker stopped: mirror trading disabled"
      });
      if (wsManager) wsManager.close();
      return;
    }

    const traders = getEnabledMirrorTraders();

    // Keep WS subscriptions in sync with enabled mirror traders.
    if (wsManager) {
      wsManager.syncSubscriptions(traders.map((t) => t.address)).catch((error) => {
        console.error(JSON.stringify({
          event: "MIRROR_WS_SYNC_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }));
      });

      // Sync pool/curve subscriptions for open mirror positions so we can keep
      // mirror_positions.current_price_usd fresh in real time.
      const openPositions = db
        .prepare(
          "SELECT * FROM mirror_positions WHERE status = 'open' AND monitor_type IS NOT NULL"
        )
        .all() as DbMirrorPosition[];

      const requiredAccounts = new Map<string, Set<string>>();
      const requiredKind = new Map<string, "spltoken" | "bonding" | "clmm_pool">();

      for (const pos of openPositions) {
        if (
          pos.monitor_type === "pumpswap" ||
          pos.monitor_type === "raydium_amm_v4" ||
          pos.monitor_type === "raydium_cpmm"
        ) {
          if (!pos.pool_base_vault || !pos.pool_quote_vault) continue;
          for (const vault of [pos.pool_base_vault, pos.pool_quote_vault]) {
            const set = requiredAccounts.get(vault) || new Set<string>();
            set.add(pos.id);
            requiredAccounts.set(vault, set);
            requiredKind.set(vault, "spltoken");
          }
        } else if (pos.monitor_type === "pumpfun") {
          if (!pos.pool_address) continue;
          const set = requiredAccounts.get(pos.pool_address) || new Set<string>();
          set.add(pos.id);
          requiredAccounts.set(pos.pool_address, set);
          requiredKind.set(pos.pool_address, "bonding");
        } else if (pos.monitor_type === "raydium_clmm") {
          if (!pos.pool_address) continue;
          const set = requiredAccounts.get(pos.pool_address) || new Set<string>();
          set.add(pos.id);
          requiredAccounts.set(pos.pool_address, set);
          requiredKind.set(pos.pool_address, "clmm_pool");
        }
      }

      positionsByAccount.clear();
      for (const [acc, ids] of requiredAccounts) positionsByAccount.set(acc, ids);
      for (const [acc, kind] of requiredKind) accountKind.set(acc, kind);

      for (const acc of requiredAccounts.keys()) {
        if (!subscribedAccounts.has(acc)) {
          subscribedAccounts.add(acc);
          wsManager.subscribeAccount(acc).catch(() => undefined);
        }
      }
      for (const acc of [...subscribedAccounts]) {
        if (!requiredAccounts.has(acc)) {
          subscribedAccounts.delete(acc);
          vaultAmounts.delete(acc);
          bondingCurveCache.delete(acc);
          clmmPoolCache.delete(acc);
          accountKind.delete(acc);
          wsManager.unsubscribeAccount(acc).catch(() => undefined);
        }
      }
    }

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
