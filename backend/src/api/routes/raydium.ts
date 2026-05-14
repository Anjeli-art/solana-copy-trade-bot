import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
import { findRaydiumPoolId } from "../services/raydiumSwap";
import { executeJupiterBuy, executeJupiterSell, getJupiterTokenPriceUsd } from "../services/jupiterSwap";
import { createBotLog } from "../services/logs";
import { logTokenSafetyBeforeBuy } from "../services/tokenSafety";
import { refreshWalletBalance } from "../services/walletBalance";
import {
  addActivePosition,
  closeActivePosition as closeActivePositionInStore,
  readState
} from "../state/store";
import { isPositiveNumber, isSolanaAddress } from "../validation";

type RaydiumBuyBody = {
  tokenMint?: string;
  amountSol?: number;
  sourceTrader?: string;
};

type RaydiumSellBody = {
  positionId?: string;
};

function getPnlUsd(amountUsd: number, entryPriceUsd: number, exitPriceUsd: number) {
  if (entryPriceUsd <= 0) {
    return 0;
  }

  return amountUsd * (exitPriceUsd / entryPriceUsd) - amountUsd;
}

export async function handleRaydium(request: IncomingMessage, response: ServerResponse, action?: string) {
  if (request.method === "GET" && action === "pool") {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1:3001"}`);
    const tokenMint = url.searchParams.get("tokenMint") || "";

    if (!isSolanaAddress(tokenMint)) {
      sendError(response, 400, "INVALID_TOKEN_MINT", "tokenMint must be a valid Solana mint address");
      return;
    }

    const poolId = await findRaydiumPoolId(tokenMint);
    sendJson(response, 200, { data: { tokenMint, poolId, platform: "Raydium" } });
    return;
  }

  if (request.method === "POST" && action === "buy") {
    const body = await readJsonBody<RaydiumBuyBody>(request);

    if (!isSolanaAddress(body.tokenMint)) {
      sendError(response, 400, "INVALID_TOKEN_MINT", "tokenMint must be a valid Solana mint address");
      return;
    }

    const state = await readState();
    const amountSol = body.amountSol ?? state.settings.buyAmountSol;
    if (!isPositiveNumber(amountSol)) {
      sendError(response, 400, "INVALID_BUY_AMOUNT", "amountSol must be a positive number");
      return;
    }

    await logTokenSafetyBeforeBuy({
      tokenMint: body.tokenMint!,
      amountSol,
      trader: body.sourceTrader || "manual",
      source: "manual"
    });

    const result = await executeJupiterBuy(body.tokenMint, amountSol);
    const tokenAmount = result.tokenAmountDelta || 0;
    const amountUsd = amountSol * state.wallet.solPriceUsd;
    const entryPriceUsd = tokenAmount > 0 && amountUsd > 0 ? amountUsd / tokenAmount : 0;
    const nextState = await addActivePosition({
      id: randomUUID(),
      tokenSymbol: body.tokenMint!.slice(0, 6),
      tokenMint: body.tokenMint!,
      sourceTrader: body.sourceTrader || "manual",
      buyPlatform: "Jupiter",
      buyTx: result.signature,
      entryPriceUsd,
      currentPriceUsd: entryPriceUsd,
      amountUsd,
      solSpent: amountSol,
      tokenAmount,
      openedAt: new Date().toISOString(),
      status: "open"
    });

    sendJson(response, 200, {
      data: {
        result,
        activePositions: nextState.activePositions
      }
    });
    return;
  }

  if (request.method === "POST" && action === "sell-position") {
    const body = await readJsonBody<RaydiumSellBody>(request);
    const state = await readState();
    const position = state.activePositions.find((item) => item.id === body.positionId);

    if (!position) {
      sendError(response, 404, "POSITION_NOT_FOUND", "Position not found");
      return;
    }

    const wallet = await refreshWalletBalance(state.wallet);
    const exitPriceUsd = await getJupiterTokenPriceUsd(position.tokenMint, position.tokenAmount, wallet.solPriceUsd);
    const result = await executeJupiterSell(position.tokenMint, position.tokenAmount);
    const pnlUsd = getPnlUsd(position.amountUsd, position.entryPriceUsd, exitPriceUsd || position.currentPriceUsd);
    const nextState = await closeActivePositionInStore(
      {
        id: position.id,
        tokenSymbol: position.tokenSymbol,
        tokenMint: position.tokenMint,
        sourceTrader: position.sourceTrader,
        buyPlatform: position.buyPlatform,
        buyTx: position.buyTx,
        entryPriceUsd: position.entryPriceUsd,
        exitPriceUsd: exitPriceUsd || position.currentPriceUsd,
        amountUsd: position.amountUsd,
        solSpent: position.solSpent,
        tokenAmount: position.tokenAmount,
        openedAt: position.openedAt,
        exitPlatform: "Jupiter",
        closedAt: new Date().toISOString(),
        closeReason: "manual",
        sellTx: result.signature
      },
      pnlUsd,
      wallet
    );
    createBotLog({
      event: "MANUAL_SELL_EXECUTED",
      message: `Manual sold ${position.tokenMint} through Jupiter`,
      wallet: position.sourceTrader,
      trader: position.sourceTrader,
      tokenMint: position.tokenMint,
      positionId: position.id,
      signature: result.signature,
      metadata: {
        exitPriceUsd: exitPriceUsd || position.currentPriceUsd,
        outputSol: result.outputSol,
        executionRoute: "Jupiter"
      }
    });

    sendJson(response, 200, {
      data: {
        result,
        activePositions: nextState.activePositions,
        closedPositions: nextState.closedPositions,
        wallet: nextState.wallet
      }
    });
    return;
  }

  sendError(response, 404, "SWAP_ACTION_NOT_FOUND", "Swap action not found");
}
