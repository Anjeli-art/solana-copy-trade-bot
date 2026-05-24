import { useCallback, useEffect, useState } from "react";
import {
  addBlacklistedToken,
  closeActivePosition,
  deleteBlacklistedToken,
  deleteManualRepeatToken,
  getBlacklistedTokens,
  getManualRepeatTokens,
  getState,
  refreshWallet,
  repeatBuyToken,
  saveSettings,
  updatePositionProfitTier
} from "../api/client";
import type { BlacklistedToken, BotWallet, ClosedPosition, ManualRepeatToken, Position, Trader } from "../types";

type SetApiError = (message: string) => void;

const EMPTY_WALLET: BotWallet = {
  address: "",
  solBalance: 0,
  solPriceUsd: 0,
  realizedPnlTodayUsd: 0,
  lastUpdated: new Date(0).toISOString()
};

export function useBotState(setApiError: SetApiError, refreshAnalytics: () => Promise<void>) {
  const [traders, setTraders] = useState<Trader[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([]);
  const [manualRepeatTokens, setManualRepeatTokens] = useState<ManualRepeatToken[]>([]);
  const [blacklistedTokens, setBlacklistedTokens] = useState<BlacklistedToken[]>([]);
  const [wallet, setWallet] = useState<BotWallet>(EMPTY_WALLET);
  const [takeProfit, setTakeProfit] = useState(1.5);
  const [draftTakeProfit, setDraftTakeProfit] = useState(1.5);
  const [highTakeProfit, setHighTakeProfit] = useState(1.05);
  const [draftHighTakeProfit, setDraftHighTakeProfit] = useState(1.05);
  const [stopLoss, setStopLoss] = useState(0.7);
  const [draftStopLoss, setDraftStopLoss] = useState(0.7);
  const [positionTimeoutMinutes, setPositionTimeoutMinutes] = useState(120);
  const [draftPositionTimeoutMinutes, setDraftPositionTimeoutMinutes] = useState(120);
  const [buyAmountSol, setBuyAmountSol] = useState(0.03);
  const [draftBuyAmountSol, setDraftBuyAmountSol] = useState(0.03);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadedState, setHasLoadedState] = useState(false);
  const [isWalletRefreshing, setIsWalletRefreshing] = useState(false);
  const [repeatBuyingMint, setRepeatBuyingMint] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    try {
      setApiError("");
      const state = await getState();
      setTraders(state.trackedTraders);
      setPositions(state.activePositions);
      setClosedPositions(state.closedPositions);
      setWallet(state.wallet);
      setTakeProfit(state.settings.profitTargetMultiplier);
      setDraftTakeProfit(state.settings.profitTargetMultiplier);
      setHighTakeProfit(state.settings.highProfitTargetMultiplier);
      setDraftHighTakeProfit(state.settings.highProfitTargetMultiplier);
      setStopLoss(state.settings.stopLossMultiplier);
      setDraftStopLoss(state.settings.stopLossMultiplier);
      setPositionTimeoutMinutes(state.settings.positionTimeoutMinutes);
      setDraftPositionTimeoutMinutes(state.settings.positionTimeoutMinutes);
      setBuyAmountSol(state.settings.buyAmountSol);
      setDraftBuyAmountSol(state.settings.buyAmountSol);
      setManualRepeatTokens(await getManualRepeatTokens());
      setBlacklistedTokens(await getBlacklistedTokens());
      setHasLoadedState(true);
    } catch (fetchError) {
      setApiError(fetchError instanceof Error ? fetchError.message : "Backend API unavailable");
    } finally {
      setIsLoading(false);
    }
  }, [setApiError]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const saveTradingSettings = useCallback(async () => {
    try {
      setApiError("");
      const settings = await saveSettings({
        profitTargetMultiplier: draftTakeProfit,
        highProfitTargetMultiplier: draftHighTakeProfit,
        stopLossMultiplier: draftStopLoss,
        positionTimeoutMinutes: draftPositionTimeoutMinutes,
        buyAmountSol: draftBuyAmountSol
      });
      setTakeProfit(settings.profitTargetMultiplier);
      setDraftTakeProfit(settings.profitTargetMultiplier);
      setHighTakeProfit(settings.highProfitTargetMultiplier);
      setDraftHighTakeProfit(settings.highProfitTargetMultiplier);
      setStopLoss(settings.stopLossMultiplier);
      setDraftStopLoss(settings.stopLossMultiplier);
      setPositionTimeoutMinutes(settings.positionTimeoutMinutes);
      setDraftPositionTimeoutMinutes(settings.positionTimeoutMinutes);
      setBuyAmountSol(settings.buyAmountSol);
      setDraftBuyAmountSol(settings.buyAmountSol);
      await refreshState();
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to save trading settings");
    }
  }, [
    draftBuyAmountSol,
    draftHighTakeProfit,
    draftPositionTimeoutMinutes,
    draftStopLoss,
    draftTakeProfit,
    refreshState,
    setApiError
  ]);

  const refreshBotWallet = useCallback(async () => {
    try {
      setApiError("");
      setIsWalletRefreshing(true);
      const nextWallet = await refreshWallet();
      setWallet(nextWallet);
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to refresh wallet");
    } finally {
      setIsWalletRefreshing(false);
    }
  }, [setApiError]);

  const sellPosition = useCallback(
    async (id: string) => {
      try {
        setApiError("");
        const result = await closeActivePosition(id);
        setPositions(result.activePositions);
        setClosedPositions(result.closedPositions);
        setWallet(result.wallet);
        await refreshAnalytics();
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to close position");
      }
    },
    [refreshAnalytics, setApiError]
  );

  const movePositionProfitTier = useCallback(
    async (id: string, profitTier: "low" | "high") => {
      try {
        setApiError("");
        setPositions(await updatePositionProfitTier(id, profitTier));
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to move position profit tier");
      }
    },
    [setApiError]
  );

  const repeatBuyKnownToken = useCallback(
    async (tokenMint: string) => {
      try {
        setApiError("");
        setRepeatBuyingMint(tokenMint);
        const result = await repeatBuyToken(tokenMint, buyAmountSol);
        setPositions(result.activePositions);
        setClosedPositions(result.closedPositions);
        setWallet(result.wallet);
        setManualRepeatTokens(await getManualRepeatTokens());
        await refreshAnalytics();
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to repeat buy token");
      } finally {
        setRepeatBuyingMint(null);
      }
    },
    [buyAmountSol, refreshAnalytics, setApiError]
  );

  const removeManualRepeatToken = useCallback(
    async (tokenMint: string) => {
      try {
        setApiError("");
        await deleteManualRepeatToken(tokenMint);
        setManualRepeatTokens((current) => current.filter((token) => token.tokenMint !== tokenMint));
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to delete manual token");
      }
    },
    [setApiError]
  );

  const blockToken = useCallback(
    async (tokenMint: string, reason?: string) => {
      try {
        setApiError("");
        setBlacklistedTokens(await addBlacklistedToken(tokenMint, reason));
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to add token to blacklist");
      }
    },
    [setApiError]
  );

  const unblockToken = useCallback(
    async (tokenMint: string) => {
      try {
        setApiError("");
        await deleteBlacklistedToken(tokenMint);
        setBlacklistedTokens((current) => current.filter((token) => token.tokenMint !== tokenMint));
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to remove token from blacklist");
      }
    },
    [setApiError]
  );

  return {
    traders,
    setTraders,
    positions,
    closedPositions,
    manualRepeatTokens,
    blacklistedTokens,
    wallet,
    takeProfit,
    draftTakeProfit,
    highTakeProfit,
    draftHighTakeProfit,
    stopLoss,
    draftStopLoss,
    positionTimeoutMinutes,
    draftPositionTimeoutMinutes,
    buyAmountSol,
    draftBuyAmountSol,
    isLoading,
    hasLoadedState,
    isWalletRefreshing,
    repeatBuyingMint,
    setDraftTakeProfit,
    setDraftHighTakeProfit,
    setDraftStopLoss,
    setDraftPositionTimeoutMinutes,
    setDraftBuyAmountSol,
    refreshState,
    saveTradingSettings,
    refreshBotWallet,
    sellPosition,
    movePositionProfitTier,
    repeatBuyKnownToken,
    removeManualRepeatToken,
    blockToken,
    unblockToken
  };
}
