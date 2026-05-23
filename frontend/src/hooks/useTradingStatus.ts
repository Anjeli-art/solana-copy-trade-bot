import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getTradingStatus,
  startCopyTrading,
  startProfitWatcher,
  stopCopyTrading,
  stopProfitWatcher
} from "../api/client";

type SetApiError = (message: string) => void;

export function useTradingStatus(setApiError: SetApiError) {
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [profitEnabled, setProfitEnabled] = useState(false);
  const [updatingTradingMode, setUpdatingTradingMode] = useState<"copy" | "profit" | null>(null);

  const hasActiveAutomation = useMemo(() => copyEnabled || profitEnabled, [copyEnabled, profitEnabled]);

  const applyStatus = useCallback((status: { copyEnabled: boolean; profitEnabled: boolean }) => {
    setCopyEnabled(status.copyEnabled);
    setProfitEnabled(status.profitEnabled);
  }, []);

  const refreshTradingStatus = useCallback(async () => {
    try {
      const status = await getTradingStatus();
      applyStatus(status);
    } catch {
      setCopyEnabled(false);
      setProfitEnabled(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    refreshTradingStatus();
  }, [refreshTradingStatus]);

  const toggleCopyTrading = useCallback(async () => {
    try {
      setApiError("");
      setUpdatingTradingMode("copy");
      const status = copyEnabled ? await stopCopyTrading() : await startCopyTrading();
      applyStatus(status);
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to update auto buy");
    } finally {
      setUpdatingTradingMode(null);
    }
  }, [applyStatus, copyEnabled, setApiError]);

  const toggleProfitWatcher = useCallback(async () => {
    try {
      setApiError("");
      setUpdatingTradingMode("profit");
      const status = profitEnabled ? await stopProfitWatcher() : await startProfitWatcher();
      applyStatus(status);
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to update auto sell");
    } finally {
      setUpdatingTradingMode(null);
    }
  }, [applyStatus, profitEnabled, setApiError]);

  return {
    copyEnabled,
    profitEnabled,
    hasActiveAutomation,
    updatingTradingMode,
    toggleCopyTrading,
    toggleProfitWatcher
  };
}
