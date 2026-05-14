import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
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
    buyPlatform: normalizePlatformName(body.buyPlatform),
    buyTx: body.buyTx,
    entryPriceUsd: body.entryPriceUsd,
    currentPriceUsd: body.currentPriceUsd,
    amountUsd: body.amountUsd,
    solSpent: body.solSpent,
    tokenAmount: body.tokenAmount,
    openedAt: body.openedAt || new Date().toISOString(),
    status: body.status === "selling" ? "selling" : "open"
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
  if (!["take-profit", "manual", "stop-loss", "timeout"].includes(closeReason)) {
    return null;
  }

  return {
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
      ...(body.buyTx !== undefined ? { buyTx: body.buyTx } : {})
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
