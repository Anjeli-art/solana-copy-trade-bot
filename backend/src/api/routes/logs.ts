import type { IncomingMessage, ServerResponse } from "http";
import { sendError, sendJson } from "../http/response";
import { listBotLogs } from "../services/logs";

export async function handleLogs(request: IncomingMessage, response: ServerResponse) {
  if (request.method === "GET") {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1:3001"}`);
    const limit = Number(url.searchParams.get("limit") || 200);
    sendJson(response, 200, { data: listBotLogs(limit) });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
