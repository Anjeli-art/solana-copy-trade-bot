import type { IncomingMessage, ServerResponse } from "http";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
import { readState, saveWallet } from "../state/store";
import { refreshWalletBalance } from "../services/walletBalance";
import type { BotWalletSnapshot } from "../types";
import { isPositiveNumber, isSolanaAddress } from "../validation";

type WalletBody = Partial<BotWalletSnapshot>;

export async function handleWallet(request: IncomingMessage, response: ServerResponse) {
  if (request.method === "GET") {
    const currentState = await readState();
    const wallet = await refreshWalletBalance(currentState.wallet);
    const state = await saveWallet(wallet);
    sendJson(response, 200, { data: state.wallet });
    return;
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    const body = await readJsonBody<WalletBody>(request);
    if (body.address !== undefined && body.address !== "" && !isSolanaAddress(body.address)) {
      sendError(response, 400, "INVALID_WALLET_ADDRESS", "address must be a valid Solana wallet address");
      return;
    }

    const current = await readState();
    const state = await saveWallet({
      ...current.wallet,
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(isPositiveNumber(body.solBalance) || body.solBalance === 0 ? { solBalance: body.solBalance } : {}),
      ...(isPositiveNumber(body.solPriceUsd) || body.solPriceUsd === 0 ? { solPriceUsd: body.solPriceUsd } : {}),
      ...(typeof body.realizedPnlTodayUsd === "number" && Number.isFinite(body.realizedPnlTodayUsd)
        ? { realizedPnlTodayUsd: body.realizedPnlTodayUsd }
        : {}),
      lastUpdated: new Date().toISOString()
    });

    sendJson(response, 200, { data: state.wallet });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
