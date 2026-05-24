import type { IncomingMessage, ServerResponse } from "http";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
import { addBlacklistedToken, deleteBlacklistedToken, listBlacklistedTokens } from "../services/tokenBlacklist";
import { isSolanaAddress } from "../validation";

type BlacklistBody = {
  tokenMint?: string;
  reason?: string;
};

export async function handleTokenBlacklist(request: IncomingMessage, response: ServerResponse, mint?: string) {
  if (request.method === "GET" && !mint) {
    sendJson(response, 200, { data: await listBlacklistedTokens() });
    return;
  }

  if (request.method === "POST" && !mint) {
    const body = await readJsonBody<BlacklistBody>(request);
    if (!body.tokenMint || !isSolanaAddress(body.tokenMint)) {
      sendError(response, 400, "INVALID_TOKEN_MINT", "tokenMint must be a valid Solana mint address");
      return;
    }

    sendJson(response, 200, { data: await addBlacklistedToken(body.tokenMint, body.reason) });
    return;
  }

  if (request.method === "DELETE" && mint) {
    if (!isSolanaAddress(mint)) {
      sendError(response, 400, "INVALID_TOKEN_MINT", "mint must be a valid Solana mint address");
      return;
    }

    deleteBlacklistedToken(mint);
    sendJson(response, 200, { data: { tokenMint: mint } });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
