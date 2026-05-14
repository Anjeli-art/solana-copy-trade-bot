import type { IncomingMessage, ServerResponse } from "http";
import { sendError, sendJson } from "../http/response";
import { listTraderAnalytics } from "../services/analytics";

export async function handleAnalytics(request: IncomingMessage, response: ServerResponse, resource?: string) {
  if (request.method === "GET" && resource === "traders") {
    sendJson(response, 200, { data: listTraderAnalytics() });
    return;
  }

  if (request.method === "GET") {
    sendError(response, 404, "NOT_FOUND", "Analytics endpoint not found");
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
