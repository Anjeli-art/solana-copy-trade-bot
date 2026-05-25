import { useCallback, useEffect, useRef, useState } from "react";
import {
  addMirrorTrader,
  deleteMirrorTrader,
  getMirrorClosedPositions,
  getMirrorPositions,
  getMirrorStatus,
  getMirrorTraders,
  patchMirrorTrader,
  sellMirrorPosition,
  startMirrorTrading,
  stopMirrorTrading
} from "../api/client";
import type { MirrorClosedPosition, MirrorPosition, MirrorStatus, MirrorTrader } from "../types";

export function useMirrorState(setApiError: (error: string) => void) {
  const [status, setStatus] = useState<MirrorStatus>({
    enabled: false,
    mirrorEnabled: false,
    processes: []
  });
  const [traders, setTraders] = useState<MirrorTrader[]>([]);
  const [positions, setPositions] = useState<MirrorPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<MirrorClosedPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [updatingMirror, setUpdatingMirror] = useState(false);
  const [sellPending, setSellPending] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [newStatus, newTraders, newPositions, newClosed] = await Promise.all([
        getMirrorStatus(),
        getMirrorTraders(),
        getMirrorPositions(),
        getMirrorClosedPositions()
      ]);
      setStatus(newStatus);
      setTraders(newTraders);
      setPositions(newPositions);
      setClosedPositions(newClosed);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Mirror API error");
    }
  }, [setApiError]);

  // Initial load
  useEffect(() => {
    setIsLoading(true);
    refresh().finally(() => setIsLoading(false));
  }, [refresh]);

  // Auto-poll when mirror is running
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    if (status.enabled) {
      pollRef.current = setInterval(refresh, 8000);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [status.enabled, refresh]);

  const toggleMirror = useCallback(async () => {
    setUpdatingMirror(true);
    try {
      const newStatus = status.enabled
        ? await stopMirrorTrading()
        : await startMirrorTrading();
      setStatus(newStatus);
      setApiError("");
      // Refresh positions after toggle
      await refresh();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Failed to toggle mirror trading");
    } finally {
      setUpdatingMirror(false);
    }
  }, [status.enabled, setApiError, refresh]);

  const addTrader = useCallback(
    async (address: string, label?: string, buyAmountSol?: number) => {
      try {
        const updated = await addMirrorTrader(address, label, buyAmountSol);
        setTraders(updated);
        setApiError("");
        return true;
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "Failed to add mirror trader");
        return false;
      }
    },
    [setApiError]
  );

  const removeTrader = useCallback(
    async (address: string) => {
      try {
        const updated = await deleteMirrorTrader(address);
        setTraders(updated);
        setApiError("");
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "Failed to remove mirror trader");
      }
    },
    [setApiError]
  );

  const updateTrader = useCallback(
    async (address: string, patch: { label?: string; enabled?: boolean; buyAmountSol?: number }) => {
      try {
        const updated = await patchMirrorTrader(address, patch);
        setTraders(updated);
        setApiError("");
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "Failed to update mirror trader");
      }
    },
    [setApiError]
  );

  const sellPosition = useCallback(
    async (id: string) => {
      setSellPending(id);
      try {
        const result = await sellMirrorPosition(id);
        setPositions(result.positions);
        await getMirrorClosedPositions().then(setClosedPositions);
        setApiError("");
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "Failed to sell mirror position");
      } finally {
        setSellPending(null);
      }
    },
    [setApiError]
  );

  return {
    status,
    traders,
    positions,
    closedPositions,
    isLoading,
    updatingMirror,
    sellPending,
    refresh,
    toggleMirror,
    addTrader,
    removeTrader,
    updateTrader,
    sellPosition
  };
}
