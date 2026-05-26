import path from "path";
import dotenv from "dotenv";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { executeJupiterSell, getJupiterSellQuote, isJupiterRateLimitError } from "../services/jupiterSwap";
import type { JupiterQuote } from "../services/jupiterSwap";
import { executePumpSwapSell } from "../services/pumpswapSwap";
import { executePumpFunSell } from "../services/pumpfunSwap";
import { executeRaydiumAmmV4Sell } from "../services/raydiumAmmV4Swap";
import { executeRaydiumCpmmSell, executeRaydiumClmmSell } from "../services/raydiumCpmmClmmSwap";
import { executeOrcaWhirlpoolSell } from "../services/orcaWhirlpoolSwap";
import { createBotLog } from "../services/logs";
import { getPositionCloseSignal } from "../services/positionRules";
import { refreshWalletBalance } from "../services/walletBalance";
import {
  closeActivePosition as closeActivePositionInStore,
  patchActivePosition,
  readState,
  recoverStaleSellingPositions
} from "../state/store";
import type { ActivePosition } from "../types";
import { createHeliusWebSocketManager, type HeliusWebSocketManager } from "../utils/heliusWebSocket";
import {
  decodeTokenAccountAmount,
  getConstantProductOutputRaw,
  WSOL_DECIMALS
} from "../services/pumpswapPool";
import BN from "bn.js";
import {
  decodeBondingCurveFromBase64,
  pumpFunSellSolFromTokens
} from "../services/pumpfunBondingCurve";
import {
  decodeClmmPoolFromBase64,
  clmmSellQuoteSol,
  type ClmmPoolDecoded
} from "../services/raydiumClmmPool";
import {
  decodeWhirlpoolFromBase64,
  whirlpoolSellQuoteSol,
  type WhirlpoolDecoded
} from "../services/orcaWhirlpoolPool";
import type { BondingCurve } from "@pump-fun/pump-sdk";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_JUPITER_RATE_LIMIT_COOLDOWN_MS = 60000;
const DEFAULT_SELLING_RECOVERY_MS = 5 * 60 * 1000;
const jupiterPriceBackoffUntilByToken = new Map<string, number>();
// Set of position ids currently being processed for a sell. Prevents two concurrent
// inspectPosition calls (polling loop + WebSocket push) from both attempting to sell
// the same position and producing duplicate logs / second failed swaps.
const sellInProgress = new Set<string>();
type ProfitTier = ActivePosition["profitTier"];

function getPollIntervalMs() {
  const value = Number(process.env.PROFIT_WATCHER_POLL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function getJupiterRateLimitCooldownMs() {
  const value = Number(process.env.JUPITER_RATE_LIMIT_COOLDOWN_MS);
  return Number.isFinite(value) && value >= 10000 ? value : DEFAULT_JUPITER_RATE_LIMIT_COOLDOWN_MS;
}

function getSellingRecoveryMs() {
  const value = Number(process.env.PROFIT_WATCHER_SELLING_RECOVERY_MS);
  return Number.isFinite(value) && value >= 60000 ? value : DEFAULT_SELLING_RECOVERY_MS;
}

function getWorkerTier(): ProfitTier {
  return process.env.PROFIT_WATCHER_TIER === "high" ? "high" : "low";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPnlUsd(
  position: ActivePosition,
  exitPriceUsd: number,
  sellActualSolChange?: number,
  solPriceUsd?: number
) {
  // Prefer actual on-chain SOL delta — includes fees, immune to bad entry/exit prices.
  if (sellActualSolChange !== undefined && position.buyActualSolChange !== undefined && solPriceUsd) {
    return (sellActualSolChange + position.buyActualSolChange) * solPriceUsd;
  }
  // Fallback to price-based when actual data missing.
  if (position.entryPriceUsd <= 0) {
    return 0;
  }
  return position.amountUsd * (exitPriceUsd / position.entryPriceUsd) - position.amountUsd;
}

async function updatePositionPrice(position: ActivePosition, currentPriceUsd: number) {
  await patchActivePosition(position.id, { currentPriceUsd });
}

async function closePositionAfterSell(
  position: ActivePosition,
  exitPriceUsd: number,
  closeReason: "take-profit" | "stop-loss" | "timeout",
  solPriceUsd: number,
  sellResult?: Awaited<ReturnType<typeof executeJupiterSell>>
) {
  const pnlUsd = getPnlUsd(position, exitPriceUsd, sellResult?.actualSolChange, solPriceUsd);

  await closeActivePositionInStore(
    {
      id: position.id,
      tokenSymbol: position.tokenSymbol,
      tokenMint: position.tokenMint,
      sourceTrader: position.sourceTrader,
      sourceSignature: position.sourceSignature,
      buyPlatform: position.buyPlatform,
      buyTx: position.buyTx,
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd,
      amountUsd: position.amountUsd,
      solSpent: position.solSpent,
      buyNetworkFeeSol: position.buyNetworkFeeSol,
      buyPriorityFeeSol: position.buyPriorityFeeSol,
      buyQuotedOutAmount: position.buyQuotedOutAmount,
      buyActualSolChange: position.buyActualSolChange,
      tokenAmount: position.tokenAmount,
      openedAt: position.openedAt,
      profitTier: position.profitTier,
      exitPlatform: "Jupiter",
      closedAt: new Date().toISOString(),
      closeReason,
      sellTx: sellResult?.signature,
      sellNetworkFeeSol: sellResult?.networkFeeSol,
      sellPriorityFeeSol: sellResult?.priorityFeeSol,
      sellQuotedOutSol: sellResult?.quotedOutSol ?? sellResult?.outputSol,
      sellActualSolChange: sellResult?.actualSolChange
    },
    pnlUsd
  );
}

async function inspectPosition(
  position: ActivePosition,
  workerTier: ProfitTier,
  targetMultiplier: number,
  stopLossMultiplier: number,
  positionTimeoutMinutes: number,
  solPriceUsd: number,
  // When set, skip the Jupiter quote and use this value directly.
  // Used by the WebSocket pool-vault path so PumpSwap positions react in real time.
  preCalculatedQuotedOutSol?: number
) {
  if (position.status !== "open" || position.tokenAmount <= 0) {
    return;
  }

  let quotedOutSol: number;
  let priceQuoteResponse: JupiterQuote | undefined;

  if (preCalculatedQuotedOutSol !== undefined) {
    // WS pipeline already computed the price from pool reserves — skip Jupiter entirely.
    quotedOutSol = preCalculatedQuotedOutSol;
  } else {
    const backoffUntil = jupiterPriceBackoffUntilByToken.get(position.tokenMint) || 0;
    if (Date.now() < backoffUntil) {
      return;
    }

    try {
      ({ quotedOutSol, quoteResponse: priceQuoteResponse } = await getJupiterSellQuote(
        position.tokenMint,
        position.tokenAmount
      ));
    } catch (error) {
      if (!isJupiterRateLimitError(error)) {
        throw error;
      }

      const cooldownMs = getJupiterRateLimitCooldownMs();
      const retryAt = new Date(Date.now() + cooldownMs).toISOString();
      jupiterPriceBackoffUntilByToken.set(position.tokenMint, Date.now() + cooldownMs);
      createBotLog({
        level: "warn",
        event: "JUPITER_PRICE_RATE_LIMITED",
        message: `Jupiter rate limit while checking position price; retry after ${Math.round(cooldownMs / 1000)}s`,
        wallet: position.sourceTrader,
        trader: position.sourceTrader,
        tokenMint: position.tokenMint,
        positionId: position.id,
        metadata: {
          cooldownMs,
          retryAt
        }
      });
      return;
    }

    jupiterPriceBackoffUntilByToken.delete(position.tokenMint);
  }

  if (quotedOutSol <= 0) {
    return;
  }

  const currentPriceUsd = solPriceUsd > 0 ? (quotedOutSol * solPriceUsd) / position.tokenAmount : 0;
  await updatePositionPrice(position, currentPriceUsd);
  const spentSol = Math.abs(position.buyActualSolChange ?? position.solSpent ?? 0);
  if (spentSol <= 0) {
    return;
  }
  const multiplier = quotedOutSol / spentSol;
  const positionAgeMs = Date.now() - new Date(position.openedAt).getTime();

  console.log(
    JSON.stringify({
      event: "PROFIT_WATCHER_PRICE_CHECK",
      positionId: position.id,
      tokenMint: position.tokenMint,
      profitTier: workerTier,
      entryPriceUsd: position.entryPriceUsd,
      currentPriceUsd,
      quotedOutSol,
      spentSol,
      multiplier,
      targetMultiplier,
      stopLossMultiplier,
      positionTimeoutMinutes,
      positionAgeMs
    })
  );

  const closeReason = getPositionCloseSignal(
    multiplier,
    targetMultiplier,
    stopLossMultiplier,
    positionAgeMs,
    positionTimeoutMinutes
  );

  if (!closeReason) {
    return;
  }

  // Claim the sell exclusively: if another concurrent path (polling vs WS push) already
  // started selling this position, bail out silently to avoid duplicate logs and a
  // doomed second swap attempt.
  if (sellInProgress.has(position.id)) {
    return;
  }
  sellInProgress.add(position.id);

  const shouldTakeProfit = closeReason === "take-profit";
  const isTimeout = closeReason === "timeout";
  createBotLog({
    level: shouldTakeProfit ? "info" : "warn",
    event: shouldTakeProfit ? "TAKE_PROFIT_REACHED" : isTimeout ? "POSITION_TIMEOUT_REACHED" : "STOP_LOSS_REACHED",
    message: shouldTakeProfit
      ? `Target reached: ${multiplier.toFixed(4)}x >= ${targetMultiplier}x`
      : isTimeout
        ? `Position timeout reached: ${positionTimeoutMinutes} minutes`
        : `Stop loss reached: ${multiplier.toFixed(4)}x <= ${stopLossMultiplier}x`,
    wallet: position.sourceTrader,
    trader: position.sourceTrader,
    tokenMint: position.tokenMint,
    positionId: position.id,
    metadata: {
      entryPriceUsd: position.entryPriceUsd,
      currentPriceUsd,
      quotedOutSol,
      spentSol,
      multiplier,
      targetMultiplier,
      stopLossMultiplier,
      positionTimeoutMinutes,
      positionAgeMs
    }
  });

  await patchActivePosition(position.id, { status: "selling", currentPriceUsd });

  // Route sell by stored monitorType, fall back to Jupiter.
  const useNativePumpSwap =
    position.monitorType === "pumpswap" && Boolean(position.poolAddress);
  const useNativePumpFun = position.monitorType === "pumpfun";
  const useNativeRaydium =
    position.monitorType === "raydium_amm_v4" && Boolean(position.poolAddress);
  const useNativeRaydiumCpmm =
    position.monitorType === "raydium_cpmm" && Boolean(position.poolAddress);
  const useNativeRaydiumClmm =
    position.monitorType === "raydium_clmm" && Boolean(position.poolAddress);
  const useNativeOrca =
    position.monitorType === "orca_whirlpool" && Boolean(position.poolAddress);
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
  const positionDecimals = position.poolBaseDecimals ?? 0;

  let result: Awaited<ReturnType<typeof executeJupiterSell>>;
  try {
    result = useNativePumpSwap
      ? (await executePumpSwapSell(
          position.tokenMint,
          position.tokenAmount,
          position.poolAddress as string
        )) as unknown as Awaited<ReturnType<typeof executeJupiterSell>>
      : useNativePumpFun
        ? (await executePumpFunSell(
            position.tokenMint,
            position.tokenAmount
          )) as unknown as Awaited<ReturnType<typeof executeJupiterSell>>
        : useNativeRaydium
          ? (await executeRaydiumAmmV4Sell(
              position.tokenMint,
              position.tokenAmount,
              position.poolAddress as string
            )) as unknown as Awaited<ReturnType<typeof executeJupiterSell>>
          : useNativeRaydiumCpmm
            ? (await executeRaydiumCpmmSell(
                position.tokenMint,
                position.tokenAmount,
                positionDecimals,
                position.poolAddress as string
              )) as unknown as Awaited<ReturnType<typeof executeJupiterSell>>
            : useNativeRaydiumClmm
              ? (await executeRaydiumClmmSell(
                  position.tokenMint,
                  position.tokenAmount,
                  positionDecimals,
                  position.poolAddress as string
                )) as unknown as Awaited<ReturnType<typeof executeJupiterSell>>
              : useNativeOrca
                ? (await executeOrcaWhirlpoolSell(
                    position.tokenMint,
                    position.tokenAmount,
                    positionDecimals,
                    position.poolAddress as string
                  )) as unknown as Awaited<ReturnType<typeof executeJupiterSell>>
                : await executeJupiterSell(position.tokenMint, position.tokenAmount, priceQuoteResponse);
  } catch (error) {
    sellInProgress.delete(position.id);
    await patchActivePosition(position.id, { status: "open", currentPriceUsd });
    createBotLog({
      level: "error",
      event: "AUTO_SELL_FAILED",
      message: error instanceof Error ? error.message : "Unknown auto sell error",
      wallet: position.sourceTrader,
      trader: position.sourceTrader,
      tokenMint: position.tokenMint,
      positionId: position.id,
      metadata: {
        closeReason,
        multiplier,
        profitTier: workerTier,
        targetMultiplier,
        stopLossMultiplier,
        positionTimeoutMinutes,
        positionAgeMs,
        exitPriceUsd: currentPriceUsd,
        sourcePlatform: position.buyPlatform,
        executionRoute
      }
    });
    throw error;
  }

  await closePositionAfterSell(
    { ...position, currentPriceUsd, status: "selling" },
    currentPriceUsd,
    closeReason,
    solPriceUsd,
    result
  );
  sellInProgress.delete(position.id);

  createBotLog({
    level: shouldTakeProfit ? "info" : "warn",
    event: shouldTakeProfit ? "AUTO_SELL_EXECUTED" : isTimeout ? "TIMEOUT_SELL_EXECUTED" : "STOP_LOSS_SELL_EXECUTED",
    message: `Auto sold ${position.tokenMint} through ${executionRoute} by ${closeReason}`,
    wallet: position.sourceTrader,
    trader: position.sourceTrader,
    tokenMint: position.tokenMint,
    positionId: position.id,
    signature: result.signature,
    metadata: {
      multiplier,
      profitTier: workerTier,
      targetMultiplier,
      stopLossMultiplier,
      positionTimeoutMinutes,
      positionAgeMs,
      closeReason,
      exitPriceUsd: currentPriceUsd,
      sourcePlatform: position.buyPlatform,
      executionRoute,
      outputSol: result.outputSol,
      quotedOutSol: result.quotedOutSol,
      networkFeeSol: result.networkFeeSol,
      priorityFeeSol: result.priorityFeeSol,
      actualSolChange: result.actualSolChange
    }
  });

  console.log(
    JSON.stringify({
      event: "PROFIT_WATCHER_SELL_EXECUTED",
      positionId: position.id,
      tokenMint: position.tokenMint,
      multiplier,
      profitTier: workerTier,
      targetMultiplier,
      stopLossMultiplier,
      positionTimeoutMinutes,
      positionAgeMs,
      closeReason,
      sellSignature: result.signature
    })
  );
}

/**
 * Compute a sell quote in SOL from cached pool data using the appropriate math.
 * Returns 0 if cache is missing or stale. Routes per monitorType:
 *   - "pumpswap" / "raydium_amm_v4" / "raydium_cpmm": two SPL token account vaults,
 *     constant-product math, fee varies by venue
 *   - "pumpfun": BondingCurve struct (virtual reserves) cached in bondingCurveCache
 *   - "raydium_clmm": pool account with sqrtPriceX64 cached in clmmPoolCache
 */
function quoteFromVaultCache(
  position: ActivePosition,
  vaultAmounts: Map<string, bigint>,
  bondingCurveCache: Map<string, BondingCurve>,
  clmmPoolCache: Map<string, ClmmPoolDecoded>,
  whirlpoolCache: Map<string, WhirlpoolDecoded>
): number {
  if (position.monitorType === "raydium_clmm") {
    if (!position.poolAddress) return 0;
    const pool = clmmPoolCache.get(position.poolAddress);
    if (!pool) return 0;
    return clmmSellQuoteSol(pool, position.tokenMint, position.tokenAmount, 25);
  }
  if (position.monitorType === "orca_whirlpool") {
    if (!position.poolAddress) return 0;
    if (position.poolBaseDecimals == null) return 0;
    const pool = whirlpoolCache.get(position.poolAddress);
    if (!pool) return 0;
    // SOL/WSOL is 9 decimals. Pass the meme decimals on whichever side it lives.
    const memeIsA = pool.mintA === position.tokenMint;
    const decimalsA = memeIsA ? position.poolBaseDecimals : 9;
    const decimalsB = memeIsA ? 9 : position.poolBaseDecimals;
    return whirlpoolSellQuoteSol(
      pool,
      position.tokenMint,
      position.tokenAmount,
      decimalsA,
      decimalsB
    );
  }
  if (position.monitorType === "pumpfun") {
    if (!position.poolAddress) return 0;
    if (position.poolBaseDecimals === undefined || position.poolBaseDecimals === null) return 0;
    const curve = bondingCurveCache.get(position.poolAddress);
    if (!curve) return 0;
    if (curve.complete) {
      // Token has graduated to PumpSwap — bonding curve is no longer the source of truth.
      // Polling fallback (Jupiter) will pick up the new pool until the position is closed.
      return 0;
    }
    const rawAmount = new BN(
      Math.max(0, Math.floor(position.tokenAmount * 10 ** position.poolBaseDecimals))
    );
    const outLamports = pumpFunSellSolFromTokens(
      curve.virtualTokenReserves,
      curve.virtualQuoteReserves,
      rawAmount,
      100 // 1% Pump.fun fee
    );
    return Number(outLamports) / LAMPORTS_PER_SOL;
  }

  // PumpSwap / Raydium AMM v4 / Raydium CPMM share two-vault constant-product math.
  // Fees differ: PumpSwap 30 bps, Raydium AMM v4 25 bps, CPMM 25 bps (default).
  if (!position.poolBaseVault || !position.poolQuoteVault) return 0;
  if (position.poolBaseDecimals === undefined || position.poolBaseDecimals === null) return 0;
  const baseAmount = vaultAmounts.get(position.poolBaseVault);
  const quoteAmount = vaultAmounts.get(position.poolQuoteVault);
  if (baseAmount === undefined || quoteAmount === undefined) return 0;
  if (baseAmount <= 0n || quoteAmount <= 0n) return 0;
  const rawAmount = BigInt(Math.max(0, Math.floor(position.tokenAmount * 10 ** position.poolBaseDecimals)));
  if (rawAmount <= 0n) return 0;
  const feeBps =
    position.monitorType === "raydium_amm_v4" || position.monitorType === "raydium_cpmm" ? 25 : 30;
  const outRaw = getConstantProductOutputRaw(baseAmount, quoteAmount, rawAmount, feeBps);
  return Number(outRaw) / LAMPORTS_PER_SOL;
}

export async function startProfitWatcherWorker() {
  const pollIntervalMs = getPollIntervalMs();
  const sellingRecoveryMs = getSellingRecoveryMs();
  const workerTier = getWorkerTier();

  // WebSocket account subscriptions for native-monitored positions.
  //
  // Two formats coexist:
  //   - PumpSwap: two SPL token vaults per position (base + quote); we cache raw u64 amounts.
  //   - Pump.fun: one bonding curve account per position; we cache the decoded BondingCurve struct.
  //
  // Each notification updates the relevant cache and triggers inspectPosition for every
  // position that depends on that account, so price moves are reacted to in ~200ms.
  const vaultAmounts = new Map<string, bigint>();
  const bondingCurveCache = new Map<string, BondingCurve>();
  const clmmPoolCache = new Map<string, ClmmPoolDecoded>();
  const whirlpoolCache = new Map<string, WhirlpoolDecoded>();
  const subscribedAccounts = new Set<string>();
  // account → positions that depend on it
  const positionsByAccount = new Map<string, Set<string>>();
  // account → which decoder to use
  //   "spltoken"  for PumpSwap / AMM v4 / CPMM vaults
  //   "bonding"   for Pump.fun bonding curve
  //   "clmm_pool" for Raydium CLMM pool state (sqrt_price)
  //   "whirlpool" for Orca Whirlpool pool state (sqrt_price)
  const accountKind = new Map<string, "spltoken" | "bonding" | "clmm_pool" | "whirlpool">();
  const wsManager: HeliusWebSocketManager | null = createHeliusWebSocketManager();

  const triggerInspectByPositionId = async (positionId: string) => {
    try {
      const state = await readState();
      const position = state.activePositions.find((p) => p.id === positionId);
      if (!position || position.status !== "open") return;
      if (position.profitTier !== workerTier) return;
      const quotedOutSol = quoteFromVaultCache(position, vaultAmounts, bondingCurveCache, clmmPoolCache, whirlpoolCache);
      if (quotedOutSol <= 0) return;
      const wallet = await refreshWalletBalance(state.wallet);
      const targetMultiplier =
        workerTier === "high"
          ? state.settings.highProfitTargetMultiplier
          : state.settings.profitTargetMultiplier;
      await inspectPosition(
        position,
        workerTier,
        targetMultiplier,
        state.settings.stopLossMultiplier,
        state.settings.positionTimeoutMinutes,
        wallet.solPriceUsd,
        quotedOutSol
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "PROFIT_WS_INSPECT_ERROR",
          positionId,
          message: error instanceof Error ? error.message : "Unknown WS-inspect error"
        })
      );
    }
  };

  if (wsManager) {
    wsManager.on("connect", () => {
      console.log(JSON.stringify({ event: "PROFIT_WS_CONNECTED", tier: workerTier }));
    });
    wsManager.on("disconnect", (reason) => {
      console.log(JSON.stringify({ event: "PROFIT_WS_DISCONNECTED", tier: workerTier, reason }));
    });
    wsManager.on("error", (error) => {
      console.error(JSON.stringify({ event: "PROFIT_WS_ERROR", tier: workerTier, message: error.message }));
    });
    wsManager.on("accountNotification", ({ account, dataBase64 }) => {
      const kind = accountKind.get(account);
      try {
        if (kind === "bonding") {
          bondingCurveCache.set(account, decodeBondingCurveFromBase64(dataBase64));
        } else if (kind === "clmm_pool") {
          clmmPoolCache.set(account, decodeClmmPoolFromBase64(dataBase64));
        } else if (kind === "whirlpool") {
          whirlpoolCache.set(account, decodeWhirlpoolFromBase64(dataBase64, account));
        } else {
          // Default to SPL Token decoder (PumpSwap / AMM v4 / CPMM vault).
          vaultAmounts.set(account, decodeTokenAccountAmount(dataBase64));
        }
      } catch {
        // Decoding failed — wrong format. Ignore this update; polling fallback will cover.
        return;
      }
      const positionIds = positionsByAccount.get(account);
      if (!positionIds) return;
      for (const positionId of positionIds) {
        triggerInspectByPositionId(positionId).catch(() => undefined);
      }
    });
    wsManager.start();
  }

  console.log(`Profit watcher started. Tier: ${workerTier}. Poll interval: ${pollIntervalMs}ms`);
  console.log(`Stale selling recovery: ${sellingRecoveryMs}ms`);
  console.log(`PumpSwap pool WebSocket: ${wsManager ? "on" : "off"}`);
  console.log("Real multi-platform sell execution through Jupiter: enabled");
  createBotLog({
    event: "PROFIT_WORKER_STARTED",
    message: `Profit watcher started. Tier: ${workerTier}. Poll: ${pollIntervalMs}ms, WS: ${wsManager ? "on" : "off"}`,
    metadata: { tier: workerTier, pollIntervalMs, sellingRecoveryMs, websocket: Boolean(wsManager) }
  });

  while (true) {
    try {
      await recoverStaleSellingPositions(sellingRecoveryMs);
      const state = await readState();
      const wallet = await refreshWalletBalance(state.wallet);
      const targetMultiplier =
        workerTier === "high"
          ? state.settings.highProfitTargetMultiplier
          : state.settings.profitTargetMultiplier;
      const stopLossMultiplier = state.settings.stopLossMultiplier;
      const positionTimeoutMinutes = state.settings.positionTimeoutMinutes;
      const positionsForTier = state.activePositions.filter((position) => position.profitTier === workerTier);

      // Sync WebSocket account subscriptions with current set of native-monitored positions.
      // Two-vault venues (PumpSwap / AMM v4 / CPMM) subscribe to base+quote token vaults.
      // Pump.fun subscribes to the bonding curve account itself.
      // CLMM subscribes to the pool state account itself (sqrt_price lives there).
      // Orca Whirlpool: same — pool state has sqrt_price.
      if (wsManager) {
        const requiredAccounts = new Map<string, Set<string>>();
        const requiredKind = new Map<string, "spltoken" | "bonding" | "clmm_pool" | "whirlpool">();

        for (const position of positionsForTier) {
          if (
            position.monitorType === "pumpswap" ||
            position.monitorType === "raydium_amm_v4" ||
            position.monitorType === "raydium_cpmm"
          ) {
            // All three share the two-vault SPL Token subscription pattern.
            if (!position.poolBaseVault || !position.poolQuoteVault) continue;
            for (const vault of [position.poolBaseVault, position.poolQuoteVault]) {
              const set = requiredAccounts.get(vault) || new Set<string>();
              set.add(position.id);
              requiredAccounts.set(vault, set);
              requiredKind.set(vault, "spltoken");
            }
          } else if (position.monitorType === "pumpfun") {
            if (!position.poolAddress) continue;
            const set = requiredAccounts.get(position.poolAddress) || new Set<string>();
            set.add(position.id);
            requiredAccounts.set(position.poolAddress, set);
            requiredKind.set(position.poolAddress, "bonding");
          } else if (position.monitorType === "raydium_clmm") {
            if (!position.poolAddress) continue;
            const set = requiredAccounts.get(position.poolAddress) || new Set<string>();
            set.add(position.id);
            requiredAccounts.set(position.poolAddress, set);
            requiredKind.set(position.poolAddress, "clmm_pool");
          } else if (position.monitorType === "orca_whirlpool") {
            if (!position.poolAddress) continue;
            const set = requiredAccounts.get(position.poolAddress) || new Set<string>();
            set.add(position.id);
            requiredAccounts.set(position.poolAddress, set);
            requiredKind.set(position.poolAddress, "whirlpool");
          }
        }

        positionsByAccount.clear();
        for (const [account, positionIds] of requiredAccounts) {
          positionsByAccount.set(account, positionIds);
        }
        for (const [account, kind] of requiredKind) {
          accountKind.set(account, kind);
        }

        // Subscribe to newly required accounts
        for (const account of requiredAccounts.keys()) {
          if (!subscribedAccounts.has(account)) {
            subscribedAccounts.add(account);
            wsManager.subscribeAccount(account).catch((error) => {
              console.error(JSON.stringify({
                event: "PROFIT_WS_SUBSCRIBE_ERROR",
                account,
                message: error instanceof Error ? error.message : String(error)
              }));
            });
          }
        }
        // Unsubscribe from accounts no longer needed (position closed, sold, etc.)
        for (const account of [...subscribedAccounts]) {
          if (!requiredAccounts.has(account)) {
            subscribedAccounts.delete(account);
            vaultAmounts.delete(account);
            bondingCurveCache.delete(account);
            clmmPoolCache.delete(account);
            whirlpoolCache.delete(account);
            accountKind.delete(account);
            wsManager.unsubscribeAccount(account).catch(() => undefined);
          }
        }
      }

      for (const position of positionsForTier) {
        try {
          // For native-monitored positions with fresh data in cache, skip Jupiter.
          let preCalculatedQuotedOutSol: number | undefined;
          if (
            position.monitorType === "pumpswap" ||
            position.monitorType === "pumpfun" ||
            position.monitorType === "raydium_amm_v4" ||
            position.monitorType === "raydium_cpmm" ||
            position.monitorType === "raydium_clmm" ||
            position.monitorType === "orca_whirlpool"
          ) {
            const cached = quoteFromVaultCache(position, vaultAmounts, bondingCurveCache, clmmPoolCache, whirlpoolCache);
            if (cached > 0) {
              preCalculatedQuotedOutSol = cached;
            }
            // If cache is empty (right after subscribe), fall back to Jupiter this cycle.
          }
          await inspectPosition(
            position,
            workerTier,
            targetMultiplier,
            stopLossMultiplier,
            positionTimeoutMinutes,
            wallet.solPriceUsd,
            preCalculatedQuotedOutSol
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "PROFIT_WATCHER_POSITION_ERROR",
              positionId: position.id,
              tokenMint: position.tokenMint,
              message: error instanceof Error ? error.message : "Unknown position watcher error"
            })
          );
          createBotLog({
            level: "error",
            event: "PROFIT_WATCHER_POSITION_ERROR",
            message: error instanceof Error ? error.message : "Unknown position watcher error",
            wallet: position.sourceTrader,
            trader: position.sourceTrader,
            tokenMint: position.tokenMint,
            positionId: position.id
          });
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "PROFIT_WATCHER_ERROR",
          message: error instanceof Error ? error.message : "Unknown profit watcher error"
        })
      );
      createBotLog({
        level: "error",
        event: "PROFIT_WATCHER_ERROR",
        message: error instanceof Error ? error.message : "Unknown profit watcher error"
      });
    }

    await sleep(pollIntervalMs);
  }
}

if (require.main === module) {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(JSON.stringify({ event: "PROFIT_WORKER_UNHANDLED_REJECTION", message }));
    createBotLog({ level: "error", event: "PROFIT_WORKER_FATAL", message });
    process.exit(1);
  });

  startProfitWatcherWorker().catch((error) => {
    const message = error instanceof Error ? error.message : "Profit watcher fatal crash";
    console.error(error);
    createBotLog({
      level: "error",
      event: "PROFIT_WORKER_FATAL",
      message,
      metadata: { stack: error instanceof Error ? error.stack?.slice(0, 1000) : undefined }
    });
    process.exit(1);
  });
}
