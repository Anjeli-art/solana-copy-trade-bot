import type { IncomingMessage, ServerResponse } from "http";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
import {
  addTrackedTrader,
  deleteTrackedTrader,
  patchTrackedTrader,
  readState
} from "../state/store";
import type { TrackedTrader } from "../types";
import { isSolanaAddress, normalizeLabel } from "../validation";

type TraderBody = {
  address?: string;
  label?: string;
  enabled?: boolean;
};

export async function handleTraders(request: IncomingMessage, response: ServerResponse, address?: string) {
  if (request.method === "GET" && !address) {
    const state = await readState();
    sendJson(response, 200, { data: state.trackedTraders });
    return;
  }

  if (request.method === "POST" && !address) {
    const body = await readJsonBody<TraderBody>(request);
    if (!isSolanaAddress(body.address)) {
      sendError(response, 400, "INVALID_TRADER_ADDRESS", "address must be a valid Solana wallet address");
      return;
    }
    const traderAddress = body.address;

    const trader: TrackedTrader = {
      address: traderAddress,
      label: normalizeLabel(body.label),
      enabled: body.enabled ?? true,
      createdAt: new Date().toISOString()
    };
    const state = await addTrackedTrader(trader);

    sendJson(response, 201, { data: state.trackedTraders });
    return;
  }

  if ((request.method === "PATCH" || request.method === "PUT") && address) {
    if (!isSolanaAddress(address)) {
      sendError(response, 400, "INVALID_TRADER_ADDRESS", "address must be a valid Solana wallet address");
      return;
    }

    const body = await readJsonBody<TraderBody>(request);
    const state = await patchTrackedTrader(address, {
      ...(body.label !== undefined ? { label: normalizeLabel(body.label) } : {}),
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {})
    });

    sendJson(response, 200, { data: state.trackedTraders });
    return;
  }

  if (request.method === "DELETE" && address) {
    if (!isSolanaAddress(address)) {
      sendError(response, 400, "INVALID_TRADER_ADDRESS", "address must be a valid Solana wallet address");
      return;
    }

    const state = await deleteTrackedTrader(address);

    sendJson(response, 200, { data: state.trackedTraders });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
