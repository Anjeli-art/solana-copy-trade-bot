import path from "path";
import dotenv from "dotenv";
import { executeJupiterSell, getJupiterTokenPriceUsd } from "../services/jupiterSwap";
import { createBotLog } from "../services/logs";
import { getPositionCloseSignal } from "../services/positionRules";
import { refreshWalletBalance } from "../services/walletBalance";
import {
  closeActivePosition as closeActivePositionInStore,
  patchActivePosition,
  readState
} from "../state/store";
import type { ActivePosition } from "../types";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_POLL_INTERVAL_MS = 5000;

function getPollIntervalMs() {
  const value = Number(process.env.PROFIT_WATCHER_POLL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPnlUsd(position: ActivePosition, exitPriceUsd: number) {
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
  sellTx?: string
) {
  const pnlUsd = getPnlUsd(position, exitPriceUsd);

  await closeActivePositionInStore(
    {
      id: position.id,
      tokenSymbol: position.tokenSymbol,
      tokenMint: position.tokenMint,
      sourceTrader: position.sourceTrader,
      buyPlatform: position.buyPlatform,
      buyTx: position.buyTx,
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd,
      amountUsd: position.amountUsd,
      solSpent: position.solSpent,
      tokenAmount: position.tokenAmount,
      openedAt: position.openedAt,
      exitPlatform: "Jupiter",
      closedAt: new Date().toISOString(),
      closeReason,
      sellTx
    },
    pnlUsd
  );
}

async function inspectPosition(
  position: ActivePosition,
  targetMultiplier: number,
  stopLossMultiplier: number,
  positionTimeoutMinutes: number,
  solPriceUsd: number
) {
  if (position.status !== "open" || position.entryPriceUsd <= 0 || position.tokenAmount <= 0) {
    return;
  }

  const currentPriceUsd = await getJupiterTokenPriceUsd(position.tokenMint, position.tokenAmount, solPriceUsd);
  if (currentPriceUsd <= 0) {
    return;
  }

  await updatePositionPrice(position, currentPriceUsd);
  const multiplier = currentPriceUsd / position.entryPriceUsd;
  const positionAgeMs = Date.now() - new Date(position.openedAt).getTime();

  console.log(
    JSON.stringify({
      event: "PROFIT_WATCHER_PRICE_CHECK",
      positionId: position.id,
      tokenMint: position.tokenMint,
      entryPriceUsd: position.entryPriceUsd,
      currentPriceUsd,
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
      multiplier,
      targetMultiplier,
      stopLossMultiplier,
      positionTimeoutMinutes,
      positionAgeMs
    }
  });

  await patchActivePosition(position.id, { status: "selling", currentPriceUsd });

  const result = await executeJupiterSell(position.tokenMint, position.tokenAmount);
  await closePositionAfterSell(
    { ...position, currentPriceUsd, status: "selling" },
    currentPriceUsd,
    closeReason,
    result.signature
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
      targetMultiplier,
      stopLossMultiplier,
      positionTimeoutMinutes,
      positionAgeMs,
      closeReason,
      exitPriceUsd: currentPriceUsd,
      sourcePlatform: position.buyPlatform,
      executionRoute: "Jupiter",
      outputSol: result.outputSol
    }
  });

  console.log(
    JSON.stringify({
      event: "PROFIT_WATCHER_SELL_EXECUTED",
      positionId: position.id,
      tokenMint: position.tokenMint,
      multiplier,
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

  console.log(`Profit watcher started. Poll interval: ${pollIntervalMs}ms`);
  console.log("Real multi-platform sell execution through Jupiter: enabled");

  while (true) {
    try {
      const state = await readState();
      const wallet = await refreshWalletBalance(state.wallet);
      const targetMultiplier = state.settings.profitTargetMultiplier;
      const stopLossMultiplier = state.settings.stopLossMultiplier;
      const positionTimeoutMinutes = state.settings.positionTimeoutMinutes;

      for (const position of state.activePositions) {
        try {
          await inspectPosition(
            position,
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
  startProfitWatcherWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
