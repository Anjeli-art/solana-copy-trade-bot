import type { IncomingMessage, ServerResponse } from "http";
import { sendError, sendJson } from "../http/response";
import { hideManualRepeatToken, listManualRepeatTokens } from "../services/manualRepeatTokens";
import { isSolanaAddress } from "../validation";

export async function handleManualTokens(request: IncomingMessage, response: ServerResponse, mint?: string) {
  if (request.method === "GET" && !mint) {
    sendJson(response, 200, { data: await listManualRepeatTokens() });
    return;
  }

  if (request.method === "DELETE" && mint) {
    if (!isSolanaAddress(mint)) {
      sendError(response, 400, "INVALID_TOKEN_MINT", "mint must be a valid Solana mint address");
      return;
    }

    hideManualRepeatToken(mint);
    sendJson(response, 200, { data: { tokenMint: mint } });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
