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
import { realtime } from "../api/wsClient";

// Backend pushes DB rows with snake_case columns. Translate to the frontend's
// camelCase shape so the rest of the UI doesn't need to know the wire format.
function mapMirrorPositionRow(row: any): MirrorPosition {
  return {
    id: row.id,
    tokenMint: row.token_mint,
    tokenSymbol: row.token_symbol ?? row.tokenSymbol ?? row.token_mint?.slice(0, 6) ?? "",
    tokenName: row.token_name ?? row.tokenName,
    tokenImage: row.token_image ?? row.tokenImage,
    mirrorTrader: row.mirror_trader ?? row.mirrorTrader,
    sourceBuySignature: row.source_buy_signature ?? row.sourceBuySignature,
    buyTx: row.buy_tx ?? row.buyTx,
    buyPlatform: row.buy_platform ?? row.buyPlatform ?? null,
    monitorType: row.monitor_type ?? row.monitorType ?? null,
    entryPriceUsd: Number(row.entry_price_usd ?? row.entryPriceUsd ?? 0),
    currentPriceUsd: Number(row.current_price_usd ?? row.currentPriceUsd ?? 0),
    tokenAmount: Number(row.token_amount ?? row.tokenAmount ?? 0),
    solSpent: Number(row.sol_spent ?? row.solSpent ?? 0),
    openedAt: row.opened_at ?? row.openedAt,
    status: row.status
  };
}

function mapMirrorClosedRow(row: any): MirrorClosedPosition {
  return {
    ...mapMirrorPositionRow(row),
    exitPriceUsd: Number(row.exit_price_usd ?? row.exitPriceUsd ?? 0),
    solReceived: row.sol_received != null ? Number(row.sol_received) : row.solReceived,
    closedAt: row.closed_at ?? row.closedAt,
    closeReason: row.close_reason ?? row.closeReason,
    exitPlatform: row.exit_platform ?? row.exitPlatform ?? null,
    sellTx: row.sell_tx ?? row.sellTx,
    ataRentRecovered: row.ata_rent_recovered != null ? Number(row.ata_rent_recovered) : row.ataRentRecovered
  } as MirrorClosedPosition;
}

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
  const fallbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // One-shot REST fetch — used on mount and as a recovery path if WS misses events.
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

  // Initial load — show data immediately while WS is still negotiating.
  useEffect(() => {
    setIsLoading(true);
    refresh().finally(() => setIsLoading(false));
  }, [refresh]);

  // Subscribe to backend WS events. No more polling — everything is push-based.
  // The realtime client auto-connects on import and reconnects with exponential
  // backoff, so we just attach handlers here.
  useEffect(() => {
    // Snapshot arrives once on connect (and on every reconnect). Use it to
    // reconcile any state that may have drifted while the socket was down.
    const offSnapshot = realtime.on("snapshot", ({ payload }) => {
      if (payload.mirrorStatus) setStatus(payload.mirrorStatus as MirrorStatus);
      if (Array.isArray(payload.mirrorPositions)) {
        setPositions(payload.mirrorPositions.map(mapMirrorPositionRow));
      }
      if (Array.isArray(payload.mirrorClosedPositions)) {
        setClosedPositions(payload.mirrorClosedPositions.map(mapMirrorClosedRow));
      }
      if (Array.isArray(payload.mirrorTraders)) {
        const mapped: MirrorTrader[] = payload.mirrorTraders.map((t: any) => ({
          address: t.address,
          label: t.label ?? null,
          enabled: Boolean(t.enabled),
          buyAmountSol: Number(t.buy_amount_sol ?? t.buyAmountSol ?? 0),
          createdAt: t.created_at ?? t.createdAt,
          updatedAt: t.updated_at ?? t.updatedAt
        }));
        setTraders(mapped);
      }
    });

    const offPositionUpdated = realtime.on("mirror_position:updated", ({ payload }) => {
      const next = mapMirrorPositionRow(payload.position);
      setPositions((prev) => {
        const idx = prev.findIndex((p) => p.id === next.id);
        if (idx === -1) return [next, ...prev];
        const copy = prev.slice();
        // Preserve token metadata that the WS push may not include.
        copy[idx] = { ...prev[idx], ...next };
        return copy;
      });
    });

    const offPositionOpened = realtime.on("mirror_position:opened", ({ payload }) => {
      const next = mapMirrorPositionRow(payload.position);
      setPositions((prev) => {
        if (prev.some((p) => p.id === next.id)) return prev;
        return [next, ...prev];
      });
    });

    const offPositionClosed = realtime.on("mirror_position:closed", ({ payload }) => {
      const closed = mapMirrorClosedRow(payload.position);
      setPositions((prev) => prev.filter((p) => p.id !== closed.id));
      setClosedPositions((prev) => [closed, ...prev.filter((p) => p.id !== closed.id)]);
    });

    const offStatus = realtime.on("mirror_status:updated", ({ payload }) => {
      if (payload.status) setStatus(payload.status as MirrorStatus);
    });

    const offTraders = realtime.on("mirror_traders:updated", ({ payload }) => {
      if (!Array.isArray(payload.traders)) return;
      const mapped: MirrorTrader[] = payload.traders.map((t: any) => ({
        address: t.address,
        label: t.label ?? null,
        enabled: Boolean(t.enabled),
        buyAmountSol: Number(t.buyAmountSol ?? t.buy_amount_sol ?? 0),
        createdAt: t.createdAt ?? t.created_at,
        updatedAt: t.updatedAt ?? t.updated_at
      }));
      setTraders(mapped);
    });

    return () => {
      offSnapshot();
      offPositionUpdated();
      offPositionOpened();
      offPositionClosed();
      offStatus();
      offTraders();
    };
  }, []);

  // Fallback polling — kicks in only if the WS has been down for >10 seconds.
  // Keeps the UI alive even on flaky networks without hammering the API.
  useEffect(() => {
    let downSince: number | null = null;
    const unsub = realtime.onStatus((s) => {
      if (s === "open") {
        downSince = null;
        if (fallbackPollRef.current) {
          clearInterval(fallbackPollRef.current);
          fallbackPollRef.current = null;
        }
      } else if (downSince == null) {
        downSince = Date.now();
        // Wait 10s before starting fallback poll so brief reconnect blips
        // don't trigger unnecessary HTTP traffic.
        window.setTimeout(() => {
          if (realtime.getStatus() !== "open" && !fallbackPollRef.current) {
            fallbackPollRef.current = setInterval(refresh, 5000);
          }
        }, 10_000);
      }
    });
    return () => {
      unsub();
      if (fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
      }
    };
  }, [refresh]);

  const toggleMirror = useCallback(async () => {
    setUpdatingMirror(true);
    try {
      const newStatus = status.enabled
        ? await stopMirrorTrading()
        : await startMirrorTrading();
      setStatus(newStatus);
      setApiError("");
      // Don't refetch — the WS snapshot/status event will reconcile.
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Failed to toggle mirror trading");
    } finally {
      setUpdatingMirror(false);
    }
  }, [status.enabled, setApiError]);

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
        await sellMirrorPosition(id);
        // WS will push the close event automatically — no refetch needed.
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
