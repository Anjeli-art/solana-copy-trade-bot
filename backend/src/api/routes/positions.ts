import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
import { getJupiterSellQuote } from "../services/jupiterSwap";
import {
  addActivePosition,
  closeActivePosition as closeActivePositionInStore,
  deleteActivePosition,
  patchActivePosition,
  readState
} from "../state/store";
import type { ActivePosition, CloseReason, ClosedPosition, PlatformName } from "../types";
import { isPositiveNumber, isSolanaAddress } from "../validation";

type PositionBody = Partial<ActivePosition>;
type ClosePositionBody = {
  exitPriceUsd?: number;
  closeReason?: CloseReason;
  sellTx?: string;
};

function normalizePlatformName(value?: string): PlatformName {
  if (["Raydium", "Orca", "Meteora", "Pump.fun", "PumpSwap", "Jupiter"].includes(value || "")) {
    return value as PlatformName;
  }

  return "Jupiter";
}

function createPosition(body: PositionBody): ActivePosition | null {
  if (!body.tokenSymbol || typeof body.tokenSymbol !== "string") return null;
  if (!isSolanaAddress(body.tokenMint)) return null;
  if (!isSolanaAddress(body.sourceTrader)) return null;
  if (!isPositiveNumber(body.entryPriceUsd)) return null;
  if (!isPositiveNumber(body.currentPriceUsd)) return null;
  if (!isPositiveNumber(body.amountUsd)) return null;
  if (!isPositiveNumber(body.tokenAmount)) return null;

  return {
    id: body.id || randomUUID(),
    tokenSymbol: body.tokenSymbol.slice(0, 24),
    tokenMint: body.tokenMint,
    sourceTrader: body.sourceTrader,
    sourceSignature: body.sourceSignature,
    buyPlatform: normalizePlatformName(body.buyPlatform),
    buyTx: body.buyTx,
    entryPriceUsd: body.entryPriceUsd,
    currentPriceUsd: body.currentPriceUsd,
    amountUsd: body.amountUsd,
    solSpent: body.solSpent,
    buyNetworkFeeSol: body.buyNetworkFeeSol,
    buyPriorityFeeSol: body.buyPriorityFeeSol,
    buyQuotedOutAmount: body.buyQuotedOutAmount,
    buyActualSolChange: body.buyActualSolChange,
    tokenAmount: body.tokenAmount,
    openedAt: body.openedAt || new Date().toISOString(),
    status: body.status === "selling" ? "selling" : "open",
    profitTier: body.profitTier === "low" ? "low" : "high"
  };
}

function getPnlUsd(position: ActivePosition, exitPriceUsd: number) {
  return position.amountUsd * (exitPriceUsd / position.entryPriceUsd) - position.amountUsd;
}

function closePosition(position: ActivePosition, body: ClosePositionBody): ClosedPosition | null {
  const exitPriceUsd = body.exitPriceUsd ?? position.currentPriceUsd;
  if (!isPositiveNumber(exitPriceUsd)) {
    return null;
  }

  const closeReason = body.closeReason || "manual";
  if (!["take-profit", "manual", "stop-loss", "timeout", "deleted"].includes(closeReason)) {
    return null;
  }

  return {
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
    sellTx: body.sellTx
  };
}

export async function handleActivePositions(
  request: IncomingMessage,
  response: ServerResponse,
  id?: string,
  action?: string
) {
  if (request.method === "GET" && !id) {
    const state = await readState();
    sendJson(response, 200, { data: state.activePositions });
    return;
  }

  if (request.method === "GET" && id && action === "average-down") {
    const state = await readState();
    const position = state.activePositions.find((p) => p.id === id);

    if (!position) {
      sendError(response, 404, "POSITION_NOT_FOUND", "Position not found");
      return;
    }

    const spentSol = Math.abs(position.buyActualSolChange ?? position.solSpent ?? 0);
    if (spentSol <= 0) {
      sendError(response, 400, "INVALID_POSITION", "Position has no recorded SOL cost");
      return;
    }

    let quotedOutSol: number;
    try {
      ({ quotedOutSol } = await getJupiterSellQuote(position.tokenMint, position.tokenAmount));
    } catch {
      sendError(response, 502, "PRICE_UNAVAILABLE", "Unable to get current price from Jupiter");
      return;
    }

    if (quotedOutSol <= 0) {
      sendError(response, 422, "PRICE_UNAVAILABLE", "Jupiter returned zero price for token");
      return;
    }

    const T = state.settings.profitTargetMultiplier;
    const currentMultiplier = quotedOutSol / spentSol;
    const dcaSol = (spentSol - T * quotedOutSol) / (T - 1);

    if (dcaSol <= 0) {
      if (currentMultiplier >= T) {
        sendError(response, 400, "NO_DCA_NEEDED", `Position is already at take-profit (${(currentMultiplier * 100 - 100).toFixed(1)}% up)`);
      } else if (currentMultiplier >= 1) {
        sendError(response, 400, "NO_DCA_NEEDED", `Position is currently profitable — sell or wait for take-profit`);
      } else {
        const dropPct = (1 - currentMultiplier) * 100;
        const neededPct = (1 - 1 / T) * 100;
        sendError(response, 400, "NO_DCA_NEEDED", `Position is only down ${dropPct.toFixed(1)}% — averaging makes sense below ${neededPct.toFixed(1)}% loss`);
      }
      return;
    }

    // Additional tokens received at current price
    const additionalTokens = (dcaSol / quotedOutSol) * position.tokenAmount;
    const newTokenAmount = position.tokenAmount + additionalTokens;
    const newSolSpent = spentSol + dcaSol;

    // New average entry price in USD
    const solPriceUsd = state.wallet.solPriceUsd;
    const newAvgEntryUsd = solPriceUsd > 0 && newTokenAmount > 0
      ? (newSolSpent * solPriceUsd) / newTokenAmount
      : 0;

    // After DCA: multiplier at current price = 1/T
    // Break-even when price rises by T from current (e.g. +2%)
    // Take-profit when price rises by T² from current (e.g. +4.04%)
    const breakEvenRecoveryPct = (T - 1) * 100;
    const takeProfitRecoveryPct = (T * T - 1) * 100;

    sendJson(response, 200, {
      data: {
        dcaSol,
        currentMultiplier,
        targetMultiplier: T,
        newAvgEntryUsd,
        breakEvenRecoveryPct,
        takeProfitRecoveryPct,
        newSolSpent,
        newTokenAmount
      }
    });
    return;
  }

  if (request.method === "POST" && !id) {
    const body = await readJsonBody<PositionBody>(request);
    const position = createPosition(body);
    if (!position) {
      sendError(response, 400, "INVALID_POSITION", "Position payload is invalid");
      return;
    }

    const state = await addActivePosition(position);

    sendJson(response, 201, { data: state.activePositions });
    return;
  }

  if ((request.method === "PATCH" || request.method === "PUT") && id) {
    const body = await readJsonBody<PositionBody>(request);
    const state = await patchActivePosition(id, {
      ...(isPositiveNumber(body.currentPriceUsd) ? { currentPriceUsd: body.currentPriceUsd } : {}),
      ...(body.status === "open" || body.status === "selling" ? { status: body.status } : {}),
      ...(body.buyTx !== undefined ? { buyTx: body.buyTx } : {}),
      ...(body.profitTier === "low" || body.profitTier === "high" ? { profitTier: body.profitTier } : {})
    });

    sendJson(response, 200, { data: state.activePositions });
    return;
  }

  if (request.method === "POST" && id && action === "close") {
    const body = await readJsonBody<ClosePositionBody>(request);
    const currentState = await readState();
    const position = currentState.activePositions.find((item) => item.id === id);

    if (!position) {
      sendError(response, 404, "POSITION_NOT_FOUND", "Position not found");
      return;
    }

    const closedPosition = closePosition(position, body);
    if (!closedPosition) {
      sendError(response, 400, "INVALID_CLOSE_POSITION", "Close position payload is invalid");
      return;
    }

    const pnlUsd = getPnlUsd(position, closedPosition.exitPriceUsd);
    const state = await closeActivePositionInStore(closedPosition, pnlUsd);

    sendJson(response, 200, {
      data: {
        activePositions: state.activePositions,
        closedPositions: state.closedPositions,
        wallet: state.wallet
      }
    });
    return;
  }

  if (request.method === "DELETE" && id) {
    const state = await deleteActivePosition(id);

    sendJson(response, 200, { data: state.activePositions });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}

export async function handleClosedPositions(request: IncomingMessage, response: ServerResponse) {
  if (request.method === "GET") {
    const state = await readState();
    sendJson(response, 200, { data: state.closedPositions });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
