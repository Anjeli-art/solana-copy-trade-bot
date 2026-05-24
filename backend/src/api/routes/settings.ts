import type { IncomingMessage, ServerResponse } from "http";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
import { readState, saveSettings } from "../state/store";
import { isPositiveNumber } from "../validation";

type SettingsBody = {
  profitTargetMultiplier?: number;
  highProfitTargetMultiplier?: number;
  stopLossMultiplier?: number;
  positionTimeoutMinutes?: number;
  buyAmountSol?: number;
};

export async function handleSettings(request: IncomingMessage, response: ServerResponse) {
  if (request.method === "GET") {
    const state = await readState();
    sendJson(response, 200, { data: state.settings });
    return;
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    const body = await readJsonBody<SettingsBody>(request);

    if (
      body.profitTargetMultiplier !== undefined &&
      (!isPositiveNumber(body.profitTargetMultiplier) || body.profitTargetMultiplier < 1.01)
    ) {
      sendError(response, 400, "INVALID_PROFIT_TARGET", "profitTargetMultiplier must be at least 1.01");
      return;
    }

    if (
      body.highProfitTargetMultiplier !== undefined &&
      (!isPositiveNumber(body.highProfitTargetMultiplier) || body.highProfitTargetMultiplier < 1.01)
    ) {
      sendError(response, 400, "INVALID_HIGH_PROFIT_TARGET", "highProfitTargetMultiplier must be at least 1.01");
      return;
    }

    if (body.buyAmountSol !== undefined && !isPositiveNumber(body.buyAmountSol)) {
      sendError(response, 400, "INVALID_BUY_AMOUNT", "buyAmountSol must be a positive number");
      return;
    }

    if (
      body.stopLossMultiplier !== undefined &&
      (!Number.isFinite(body.stopLossMultiplier) || body.stopLossMultiplier < 0 || body.stopLossMultiplier >= 1)
    ) {
      sendError(response, 400, "INVALID_STOP_LOSS", "stopLossMultiplier must be 0 or between 0.01 and 0.99");
      return;
    }

    if (
      body.positionTimeoutMinutes !== undefined &&
      (!Number.isFinite(body.positionTimeoutMinutes) || body.positionTimeoutMinutes < 0)
    ) {
      sendError(response, 400, "INVALID_POSITION_TIMEOUT", "positionTimeoutMinutes must be 0 or greater");
      return;
    }

    const current = await readState();
    const nextLowProfit = body.profitTargetMultiplier ?? current.settings.profitTargetMultiplier;
    const nextHighProfit = body.highProfitTargetMultiplier ?? current.settings.highProfitTargetMultiplier;
    if (nextHighProfit < nextLowProfit) {
      sendError(
        response,
        400,
        "INVALID_PROFIT_TIERS",
        "highProfitTargetMultiplier must be greater than or equal to profitTargetMultiplier"
      );
      return;
    }

    const state = await saveSettings({
      ...current.settings,
      ...(body.profitTargetMultiplier !== undefined
        ? { profitTargetMultiplier: body.profitTargetMultiplier }
        : {}),
      ...(body.highProfitTargetMultiplier !== undefined
        ? { highProfitTargetMultiplier: body.highProfitTargetMultiplier }
        : {}),
      ...(body.stopLossMultiplier !== undefined ? { stopLossMultiplier: body.stopLossMultiplier } : {}),
      ...(body.positionTimeoutMinutes !== undefined
        ? { positionTimeoutMinutes: body.positionTimeoutMinutes }
        : {}),
      ...(body.buyAmountSol !== undefined ? { buyAmountSol: body.buyAmountSol } : {})
    });

    sendJson(response, 200, { data: state.settings });
    return;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}
