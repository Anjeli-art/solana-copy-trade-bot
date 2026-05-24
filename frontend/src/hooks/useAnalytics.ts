import { useCallback, useEffect, useState } from "react";
import { getManualTokenAnalytics, getSalesAnalytics, getTraderAnalytics } from "../api/client";
import type { ManualTokenAnalytics, SalesAnalyticsBucket, TraderAnalytics } from "../types";

type SetApiError = (message: string) => void;

export function useAnalytics(setApiError: SetApiError) {
  const [analytics, setAnalytics] = useState<TraderAnalytics[]>([]);
  const [manualTokenAnalytics, setManualTokenAnalytics] = useState<ManualTokenAnalytics[]>([]);
  const [salesByDay, setSalesByDay] = useState<SalesAnalyticsBucket[]>([]);
  const [salesByHour, setSalesByHour] = useState<SalesAnalyticsBucket[]>([]);

  const refreshAnalytics = useCallback(async () => {
    try {
      setApiError("");
      const nextAnalytics = await getTraderAnalytics();
      const nextManualTokenAnalytics = await getManualTokenAnalytics();
      const [nextSalesByDay, nextSalesByHour] = await Promise.all([
        getSalesAnalytics("day"),
        getSalesAnalytics("hour")
      ]);
      setAnalytics(nextAnalytics);
      setManualTokenAnalytics(nextManualTokenAnalytics);
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
    salesByDay,
    salesByHour,
    refreshAnalytics
  };
}
