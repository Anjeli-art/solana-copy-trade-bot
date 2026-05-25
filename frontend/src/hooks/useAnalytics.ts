import { useCallback, useEffect, useState } from "react";
import { getManualTokenAnalytics, getMirrorTraderAnalytics, getSalesAnalytics, getTraderAnalytics } from "../api/client";
import type { ManualTokenAnalytics, MirrorTraderAnalytics, SalesAnalyticsBucket, TraderAnalytics } from "../types";

type SetApiError = (message: string) => void;

export function useAnalytics(setApiError: SetApiError) {
  const [analytics, setAnalytics] = useState<TraderAnalytics[]>([]);
  const [manualTokenAnalytics, setManualTokenAnalytics] = useState<ManualTokenAnalytics[]>([]);
  const [mirrorAnalytics, setMirrorAnalytics] = useState<MirrorTraderAnalytics[]>([]);
  const [salesByDay, setSalesByDay] = useState<SalesAnalyticsBucket[]>([]);
  const [salesByHour, setSalesByHour] = useState<SalesAnalyticsBucket[]>([]);

  const refreshAnalytics = useCallback(async () => {
    try {
      setApiError("");
      const [nextAnalytics, nextManualTokenAnalytics, nextMirrorAnalytics, nextSalesByDay, nextSalesByHour] =
        await Promise.all([
          getTraderAnalytics(),
          getManualTokenAnalytics(),
          getMirrorTraderAnalytics(),
          getSalesAnalytics("day"),
          getSalesAnalytics("hour")
        ]);
      setAnalytics(nextAnalytics);
      setManualTokenAnalytics(nextManualTokenAnalytics);
      setMirrorAnalytics(nextMirrorAnalytics);
      setSalesByDay(nextSalesByDay);
      setSalesByHour(nextSalesByHour);
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
    mirrorAnalytics,
    salesByDay,
    salesByHour,
    refreshAnalytics
  };
}
