import type { IncomingMessage, ServerResponse } from "http";
import { sendError, sendJson } from "../http/response";
import { getTokenMetadata } from "../services/tokenMetadata";
import { isSolanaAddress } from "../validation";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function handleTokens(
  request: IncomingMessage,
  response: ServerResponse,
  mint?: string,
  action?: string
) {
  if (request.method === "GET" && mint && action === "metadata") {
    if (!isSolanaAddress(mint)) {
      sendError(response, 400, "INVALID_TOKEN_MINT", "mint must be a valid Solana mint address", request);
      return;
    }

    try {
      const metadata = await getTokenMetadata(mint);
      sendJson(response, 200, { data: metadata }, request);
    } catch (error) {
      sendError(response, 502, "TOKEN_METADATA_FAILED", getErrorMessage(error), request);
    }
    return;
  }

  if (mint && action !== "metadata") {
    sendError(response, 404, "TOKEN_ACTION_NOT_FOUND", "Token endpoint not found", request);
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed", request);
}
