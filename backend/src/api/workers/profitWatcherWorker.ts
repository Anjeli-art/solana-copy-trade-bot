import path from "path";
import dotenv from "dotenv";
import { executeJupiterSell, getJupiterSellQuote, isJupiterRateLimitError } from "../services/jupiterSwap";
import type { JupiterQuote } from "../services/jupiterSwap";
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

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_JUPITER_RATE_LIMIT_COOLDOWN_MS = 60000;
const DEFAULT_SELLING_RECOVERY_MS = 5 * 60 * 1000;
const jupiterPriceBackoffUntilByToken = new Map<string, number>();
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
  solPriceUsd: number
) {
  if (position.status !== "open" || position.tokenAmount <= 0) {
    return;
  }

  const backoffUntil = jupiterPriceBackoffUntilByToken.get(position.tokenMint) || 0;
  if (Date.now() < backoffUntil) {
    return;
  }

  let quotedOutSol: number;
  let priceQuoteResponse: JupiterQuote | undefined;
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

  if (quotedOutSol <= 0) {
    return;
  }

  jupiterPriceBackoffUntilByToken.delete(position.tokenMint);

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

  let result: Awaited<ReturnType<typeof executeJupiterSell>>;
  try {
    result = await executeJupiterSell(position.tokenMint, position.tokenAmount, priceQuoteResponse);
  } catch (error) {
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
        executionRoute: "Jupiter"
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

  createBotLog({
    level: shouldTakeProfit ? "info" : "warn",
    event: shouldTakeProfit ? "AUTO_SELL_EXECUTED" : isTimeout ? "TIMEOUT_SELL_EXECUTED" : "STOP_LOSS_SELL_EXECUTED",
    message: `Auto sold ${position.tokenMint} through Jupiter by ${closeReason}`,
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
      executionRoute: "Jupiter",
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

export async function startProfitWatcherWorker() {
  const pollIntervalMs = getPollIntervalMs();
  const sellingRecoveryMs = getSellingRecoveryMs();
  const workerTier = getWorkerTier();

  console.log(`Profit watcher started. Tier: ${workerTier}. Poll interval: ${pollIntervalMs}ms`);
  console.log(`Stale selling recovery: ${sellingRecoveryMs}ms`);
  console.log("Real multi-platform sell execution through Jupiter: enabled");
  createBotLog({
    event: "PROFIT_WORKER_STARTED",
    message: `Profit watcher started. Tier: ${workerTier}. Poll: ${pollIntervalMs}ms`,
    metadata: { tier: workerTier, pollIntervalMs, sellingRecoveryMs }
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

      for (const position of positionsForTier) {
        try {
          await inspectPosition(
            position,
            workerTier,
            targetMultiplier,
            stopLossMultiplier,
            positionTimeoutMinutes,
            wallet.solPriceUsd
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
