import type { IncomingMessage, ServerResponse } from "http";
import { sendError, sendJson } from "../http/response";
import { getTradingStatus, startTrading, stopTrading } from "../services/tradingEngine";

export async function handleTrading(request: IncomingMessage, response: ServerResponse, action?: string) {
  if (request.method === "GET" && !action) {
    sendJson(response, 200, { data: getTradingStatus() });
    return;
  }

  if (request.method === "POST" && action === "start") {
    sendJson(response, 200, { data: startTrading() });
    return;
  }

  if (request.method === "POST" && action === "stop") {
    sendJson(response, 200, { data: stopTrading() });
    return;
  }

  sendError(response, 404, "TRADING_ACTION_NOT_FOUND", "Trading action not found");
}
