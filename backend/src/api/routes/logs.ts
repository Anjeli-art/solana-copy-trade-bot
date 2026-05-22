import type { IncomingMessage, ServerResponse } from "http";
import { sendError, sendJson } from "../http/response";
import { deleteBotLog, listBotLogEvents, listBotLogs } from "../services/logs";

export async function handleLogs(request: IncomingMessage, response: ServerResponse, id?: string) {
  if (request.method === "GET" && id === "events") {
    sendJson(response, 200, { data: listBotLogEvents() });
    return;
  }

  if (request.method === "GET" && !id) {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1:3001"}`);
    const limit = Number(url.searchParams.get("limit") || 200);
    const event = url.searchParams.get("event") || undefined;
    sendJson(response, 200, { data: listBotLogs(limit, event) });
    return;
  }

  if (request.method === "DELETE" && id) {
    const deleted = deleteBotLog(id);
    if (!deleted) {
      sendError(response, 404, "LOG_NOT_FOUND", "Log not found");
      return;
    }

    sendJson(response, 200, { data: { id } });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
