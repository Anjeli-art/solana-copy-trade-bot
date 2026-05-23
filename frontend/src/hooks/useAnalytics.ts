import { useCallback, useEffect, useState } from "react";
import { getManualTokenAnalytics, getTraderAnalytics } from "../api/client";
import type { ManualTokenAnalytics, TraderAnalytics } from "../types";

type SetApiError = (message: string) => void;

export function useAnalytics(setApiError: SetApiError) {
  const [analytics, setAnalytics] = useState<TraderAnalytics[]>([]);
  const [manualTokenAnalytics, setManualTokenAnalytics] = useState<ManualTokenAnalytics[]>([]);

  const refreshAnalytics = useCallback(async () => {
    try {
      setApiError("");
      const nextAnalytics = await getTraderAnalytics();
      const nextManualTokenAnalytics = await getManualTokenAnalytics();
      setAnalytics(nextAnalytics);
      setManualTokenAnalytics(nextManualTokenAnalytics);
    } catch (fetchError) {
      setApiError(fetchError instanceof Error ? fetchError.message : "Failed to load analytics");
    }
  }, [setApiError]);

  useEffect(() => {
    refreshAnalytics();
  }, [refreshAnalytics]);

  return {
    analytics,
    manualTokenAnalytics,
    refreshAnalytics
  };
}
