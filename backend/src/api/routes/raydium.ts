import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { readJsonBody } from "../http/request";
import { sendError, sendJson } from "../http/response";
import { findRaydiumPoolId } from "../services/raydiumSwap";
import { executePumpSwapSell } from "../services/pumpswapSwap";
import { executePumpFunSell } from "../services/pumpfunSwap";
import { executeRaydiumAmmV4Sell } from "../services/raydiumAmmV4Swap";
import { executeRaydiumCpmmSell, executeRaydiumClmmSell } from "../services/raydiumCpmmClmmSwap";
import type { ClosedPosition } from "../types";
import {
  executeJupiterBuy,
  executeJupiterSell,
  getJupiterTokenPriceUsd,
  isJupiterRateLimitError
} from "../services/jupiterSwap";
import { createBotLog } from "../services/logs";
import { isTokenBlacklisted } from "../services/tokenBlacklist";
import { getTokenMetadata } from "../services/tokenMetadata";
import { refreshWalletBalance } from "../services/walletBalance";
import {
  addActivePosition,
  closeActivePosition as closeActivePositionInStore,
  patchActivePosition,
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

type RepeatBuyBody = {
  tokenMint?: string;
  amountSol?: number;
};

function getPnlUsd(amountUsd: number, entryPriceUsd: number, exitPriceUsd: number) {
  if (entryPriceUsd <= 0) {
    return 0;
  }

  return amountUsd * (exitPriceUsd / entryPriceUsd) - amountUsd;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function handleSwap(request: IncomingMessage, response: ServerResponse, action?: string) {
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

    if (isTokenBlacklisted(body.tokenMint)) {
      sendError(response, 409, "TOKEN_BLACKLISTED", "Token is blacklisted and cannot be bought");
      return;
    }

    const state = await readState();
    if (state.activePositions.some((position) => position.tokenMint === body.tokenMint)) {
      sendError(response, 409, "POSITION_ALREADY_EXISTS", "Active position already exists for this token");
      return;
    }

    const amountSol = body.amountSol ?? state.settings.buyAmountSol;
    if (!isPositiveNumber(amountSol)) {
      sendError(response, 400, "INVALID_BUY_AMOUNT", "amountSol must be a positive number");
      return;
    }

    let result;
    try {
      result = await executeJupiterBuy(body.tokenMint, amountSol);
    } catch (error) {
      if (isJupiterRateLimitError(error)) {
        sendError(
          response,
          429,
          "JUPITER_RATE_LIMITED",
          "Jupiter rate limit while buying token; wait a bit and try again"
        );
        return;
      }

      sendError(response, 502, "JUPITER_BUY_FAILED", getErrorMessage(error));
      return;
    }
    const tokenAmount = result.tokenAmountDelta || 0;
    const actualSolSpent = result.actualSolChange !== undefined ? Math.abs(result.actualSolChange) : amountSol;
    const amountUsd = actualSolSpent * state.wallet.solPriceUsd;
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
      solSpent: actualSolSpent,
      buyNetworkFeeSol: result.networkFeeSol,
      buyPriorityFeeSol: result.priorityFeeSol,
      buyQuotedOutAmount: result.quotedOutAmount,
      buyActualSolChange: result.actualSolChange,
      tokenAmount,
      openedAt: new Date().toISOString(),
      status: "open",
      profitTier: "high"
    });

    createBotLog({
      event: "MANUAL_BUY_EXECUTED",
      message: `Manual buy ${body.tokenMint} through Jupiter for ${amountSol} SOL`,
      wallet: body.sourceTrader || "manual",
      trader: body.sourceTrader || "manual",
      tokenMint: body.tokenMint,
      signature: result.signature,
      metadata: {
        amountSol,
        tokenAmount,
        entryPriceUsd,
        executionRoute: "Jupiter",
        quotedOutAmount: result.quotedOutAmount,
        networkFeeSol: result.networkFeeSol,
        priorityFeeSol: result.priorityFeeSol,
        actualSolChange: result.actualSolChange
      }
    });

    sendJson(response, 200, {
      data: {
        result,
        activePositions: nextState.activePositions
      }
    });
    return;
  }

  if (request.method === "POST" && action === "repeat-buy") {
    const body = await readJsonBody<RepeatBuyBody>(request);

    if (!isSolanaAddress(body.tokenMint)) {
      sendError(response, 400, "INVALID_TOKEN_MINT", "tokenMint must be a valid Solana mint address");
      return;
    }

    if (isTokenBlacklisted(body.tokenMint)) {
      sendError(response, 409, "TOKEN_BLACKLISTED", "Token is blacklisted and cannot be bought");
      return;
    }

    const state = await readState();
    if (state.activePositions.some((position) => position.tokenMint === body.tokenMint)) {
      sendError(response, 409, "POSITION_ALREADY_EXISTS", "Active position already exists for this token");
      return;
    }

    const knownPosition = [...state.activePositions, ...state.closedPositions].find(
      (position) => position.tokenMint === body.tokenMint
    );

    if (!knownPosition) {
      sendError(response, 404, "TOKEN_NOT_PREVIOUSLY_TRADED", "Token was not previously traded by this bot");
      return;
    }

    const amountSol = body.amountSol ?? state.settings.buyAmountSol;
    if (!isPositiveNumber(amountSol)) {
      sendError(response, 400, "INVALID_BUY_AMOUNT", "amountSol must be a positive number");
      return;
    }

    const wallet = await refreshWalletBalance(state.wallet);

    let result;
    try {
      result = await executeJupiterBuy(body.tokenMint, amountSol);
    } catch (error) {
      if (isJupiterRateLimitError(error)) {
        sendError(
          response,
          429,
          "JUPITER_RATE_LIMITED",
          "Jupiter rate limit while buying token; wait a bit and try again"
        );
        return;
      }

      sendError(response, 502, "JUPITER_BUY_FAILED", getErrorMessage(error));
      return;
    }
    const tokenAmount = result.tokenAmountDelta || 0;
    const actualSolSpentRepeat = result.actualSolChange !== undefined ? Math.abs(result.actualSolChange) : amountSol;
    const amountUsd = actualSolSpentRepeat * wallet.solPriceUsd;
    const entryPriceUsd = tokenAmount > 0 && amountUsd > 0 ? amountUsd / tokenAmount : 0;
    const tokenMetadata = await getTokenMetadata(body.tokenMint).catch(() => undefined);
    const nextState = await addActivePosition(
      {
        id: randomUUID(),
        tokenSymbol: tokenMetadata?.symbol || knownPosition.tokenSymbol,
        tokenName: tokenMetadata?.name || knownPosition.tokenName,
        tokenMint: body.tokenMint,
        tokenImage: tokenMetadata?.image || knownPosition.tokenImage,
        sourceTrader: "manual-repeat",
        sourceSignature: knownPosition.sourceSignature,
        buyPlatform: "Jupiter",
        buyTx: result.signature,
        entryPriceUsd,
        currentPriceUsd: entryPriceUsd,
        amountUsd,
        solSpent: actualSolSpentRepeat,
        buyNetworkFeeSol: result.networkFeeSol,
        buyPriorityFeeSol: result.priorityFeeSol,
        buyQuotedOutAmount: result.quotedOutAmount,
        buyActualSolChange: result.actualSolChange,
        tokenAmount,
        openedAt: new Date().toISOString(),
        status: "open",
        profitTier: "high"
      },
      wallet
    );

    createBotLog({
      event: "MANUAL_REPEAT_BUY_EXECUTED",
      message: `Manual repeat buy ${body.tokenMint} through Jupiter for ${amountSol} SOL`,
      wallet: "manual-repeat",
      trader: "manual-repeat",
      tokenMint: body.tokenMint,
      signature: result.signature,
      metadata: {
        amountSol,
        tokenAmount,
        entryPriceUsd,
        executionRoute: "Jupiter",
        quotedOutAmount: result.quotedOutAmount,
        networkFeeSol: result.networkFeeSol,
        priorityFeeSol: result.priorityFeeSol,
        actualSolChange: result.actualSolChange
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

  if (request.method === "POST" && action === "sell-position") {
    const body = await readJsonBody<RaydiumSellBody>(request);
    const state = await readState();
    const position = state.activePositions.find((item) => item.id === body.positionId);

    if (!position) {
      sendError(response, 404, "POSITION_NOT_FOUND", "Position not found");
      return;
    }
    if (position.status === "selling") {
      sendError(response, 409, "POSITION_ALREADY_SELLING", "Position is already being sold");
      return;
    }

    const wallet = await refreshWalletBalance(state.wallet);
    const exitPriceUsd = await getJupiterTokenPriceUsd(position.tokenMint, position.tokenAmount, wallet.solPriceUsd);
    await patchActivePosition(position.id, {
      status: "selling",
      ...(exitPriceUsd > 0 ? { currentPriceUsd: exitPriceUsd } : {})
    });
    // Route manual sell through native connector when the position has a stored monitor_type.
    // Falls back to Jupiter for non-native positions or when pool data wasn't captured at buy.
    const tokenDecimals = position.poolBaseDecimals ?? 0;
    const useNativePumpSwap =
      position.monitorType === "pumpswap" && Boolean(position.poolAddress);
    const useNativePumpFun = position.monitorType === "pumpfun";
    const useNativeRaydium =
      position.monitorType === "raydium_amm_v4" && Boolean(position.poolAddress);
    const useNativeRaydiumCpmm =
      position.monitorType === "raydium_cpmm" && Boolean(position.poolAddress);
    const useNativeRaydiumClmm =
      position.monitorType === "raydium_clmm" && Boolean(position.poolAddress);
    const executionRoute = useNativePumpSwap
      ? "PumpSwap"
      : useNativePumpFun
        ? "Pump.fun"
        : useNativeRaydium
          ? "Raydium"
          : useNativeRaydiumCpmm
            ? "Raydium-CPMM"
            : useNativeRaydiumClmm
              ? "Raydium-CLMM"
              : "Jupiter";
    let result;
    try {
      result = useNativePumpSwap
        ? await executePumpSwapSell(position.tokenMint, position.tokenAmount, position.poolAddress as string)
        : useNativePumpFun
          ? await executePumpFunSell(position.tokenMint, position.tokenAmount)
          : useNativeRaydium
            ? await executeRaydiumAmmV4Sell(position.tokenMint, position.tokenAmount, position.poolAddress as string)
            : useNativeRaydiumCpmm
              ? await executeRaydiumCpmmSell(
                  position.tokenMint,
                  position.tokenAmount,
                  tokenDecimals,
                  position.poolAddress as string
                )
              : useNativeRaydiumClmm
                ? await executeRaydiumClmmSell(
                    position.tokenMint,
                    position.tokenAmount,
                    tokenDecimals,
                    position.poolAddress as string
                  )
                : await executeJupiterSell(position.tokenMint, position.tokenAmount);
    } catch (error) {
      await patchActivePosition(position.id, {
        status: "open",
        ...(exitPriceUsd > 0 ? { currentPriceUsd: exitPriceUsd } : {})
      });
      sendError(response, 502, "MANUAL_SELL_FAILED", getErrorMessage(error));
      return;
    }
    // Prefer actual SOL in/out — includes all fees, not subject to stale price data.
    const pnlUsd =
      result.actualSolChange !== undefined && position.buyActualSolChange !== undefined
        ? (result.actualSolChange + position.buyActualSolChange) * wallet.solPriceUsd
        : getPnlUsd(position.amountUsd, position.entryPriceUsd, exitPriceUsd || position.currentPriceUsd);
    const nextState = await closeActivePositionInStore(
      {
        id: position.id,
        tokenSymbol: position.tokenSymbol,
        tokenMint: position.tokenMint,
        sourceTrader: position.sourceTrader,
        sourceSignature: position.sourceSignature,
        buyPlatform: position.buyPlatform,
        buyTx: position.buyTx,
        entryPriceUsd: position.entryPriceUsd,
        exitPriceUsd: exitPriceUsd || position.currentPriceUsd,
        amountUsd: position.amountUsd,
        solSpent: position.solSpent,
        buyNetworkFeeSol: position.buyNetworkFeeSol,
        buyPriorityFeeSol: position.buyPriorityFeeSol,
        buyQuotedOutAmount: position.buyQuotedOutAmount,
        buyActualSolChange: position.buyActualSolChange,
        tokenAmount: position.tokenAmount,
        openedAt: position.openedAt,
        profitTier: position.profitTier,
        exitPlatform: executionRoute as ClosedPosition["exitPlatform"],
        closedAt: new Date().toISOString(),
        closeReason: "manual",
        sellTx: result.signature,
        sellNetworkFeeSol: result.networkFeeSol,
        sellPriorityFeeSol: result.priorityFeeSol,
        sellQuotedOutSol: result.quotedOutSol ?? result.outputSol,
        sellActualSolChange: result.actualSolChange
      },
      pnlUsd,
      wallet
    );
    createBotLog({
      event: "MANUAL_SELL_EXECUTED",
      message: `Manual sold ${position.tokenMint} through ${executionRoute}`,
      wallet: position.sourceTrader,
      trader: position.sourceTrader,
      tokenMint: position.tokenMint,
      positionId: position.id,
      signature: result.signature,
      metadata: {
        exitPriceUsd: exitPriceUsd || position.currentPriceUsd,
        outputSol: result.outputSol,
        executionRoute,
        buyPlatform: position.buyPlatform,
        quotedOutSol: result.quotedOutSol,
        networkFeeSol: result.networkFeeSol,
        priorityFeeSol: result.priorityFeeSol,
        actualSolChange: result.actualSolChange
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
