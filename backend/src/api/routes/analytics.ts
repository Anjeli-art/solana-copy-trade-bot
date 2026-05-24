import type { IncomingMessage, ServerResponse } from "http";
import { sendError, sendJson } from "../http/response";
import { listManualTokenAnalytics, listSalesAnalytics, listTraderAnalytics } from "../services/analytics";

export async function handleAnalytics(request: IncomingMessage, response: ServerResponse, resource?: string) {
  if (request.method === "GET" && resource === "traders") {
    sendJson(response, 200, { data: listTraderAnalytics() });
    return;
  }

  if (request.method === "GET" && resource === "manual-tokens") {
    sendJson(response, 200, { data: listManualTokenAnalytics() });
    return;
  }

  if (request.method === "GET" && resource === "sales") {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const bucket = url.searchParams.get("bucket") === "hour" ? "hour" : "day";
    sendJson(response, 200, { data: listSalesAnalytics(bucket) });
    return;
  }

  if (request.method === "GET") {
    sendError(response, 404, "NOT_FOUND", "Analytics endpoint not found");
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
