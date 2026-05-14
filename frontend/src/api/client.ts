import type { BotLog, BotWallet, ClosedPosition, Position, Trader } from "../types";

type ApiResponse<T> = {
  data: T;
};

type ApiSettings = {
  profitTargetMultiplier: number;
  stopLossMultiplier: number;
  positionTimeoutMinutes: number;
  buyAmountSol: number;
};

type ApiActivePosition = {
  id: string;
  tokenSymbol: string;
  tokenMint: string;
  sourceTrader: string;
  buyPlatform: string;
  buyTx?: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  amountUsd: number;
  solSpent?: number;
  tokenAmount: number;
  openedAt: string;
  status: "open" | "selling";
};

type ApiClosedPosition = Omit<ApiActivePosition, "currentPriceUsd" | "status"> & {
  exitPriceUsd: number;
  exitPlatform: string;
  closedAt: string;
  closeReason: "take-profit" | "manual" | "stop-loss" | "timeout";
  sellTx?: string;
};

export type ApiState = {
  settings: ApiSettings;
  trackedTraders: Trader[];
  activePositions: ApiActivePosition[];
  closedPositions: ApiClosedPosition[];
  wallet: BotWallet;
};

export type TradingStatus = {
  enabled: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  processes: Array<{
    name: "copy" | "profit";
    pid?: number;
  }>;
};

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:3001";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || "API request failed");
  }

  return (payload as ApiResponse<T>).data;
}

export function mapActivePosition(position: ApiActivePosition): Position {
  return {
    id: position.id,
    tokenSymbol: position.tokenSymbol,
    tokenMint: position.tokenMint,
    platform: position.buyPlatform,
    entryPrice: position.entryPriceUsd,
    currentPrice: position.currentPriceUsd,
    amountUsd: position.amountUsd,
    solSpent: position.solSpent,
    tokenAmount: position.tokenAmount,
    trader: position.sourceTrader,
    openedAt: position.openedAt
  };
}

export function mapClosedPosition(position: ApiClosedPosition): ClosedPosition {
  return {
    id: position.id,
    tokenSymbol: position.tokenSymbol,
    tokenMint: position.tokenMint,
    platform: position.buyPlatform,
    entryPrice: position.entryPriceUsd,
    currentPrice: position.exitPriceUsd,
    amountUsd: position.amountUsd,
    solSpent: position.solSpent,
    tokenAmount: position.tokenAmount,
    trader: position.sourceTrader,
    openedAt: position.openedAt,
    exitPrice: position.exitPriceUsd,
    exitPlatform: position.exitPlatform,
    closedAt: position.closedAt,
    closeReason: position.closeReason,
    sellTx: position.sellTx || ""
  };
}

export async function getState() {
  const state = await request<ApiState>("/api/state");
  return {
    settings: state.settings,
    trackedTraders: state.trackedTraders,
    activePositions: state.activePositions.map(mapActivePosition),
    closedPositions: (state.closedPositions || []).map(mapClosedPosition),
    wallet: state.wallet
  };
}

export async function getClosedPositions() {
  const positions = await request<ApiClosedPosition[]>("/api/positions/closed");
  return positions.map(mapClosedPosition);
}

export async function closeActivePosition(id: string) {
  const result = await request<{
    activePositions: ApiActivePosition[];
    closedPositions: ApiClosedPosition[];
    wallet: BotWallet;
  }>("/api/swap/sell-position", {
    method: "POST",
    body: JSON.stringify({ positionId: id })
  });

  return {
    activePositions: result.activePositions.map(mapActivePosition),
    closedPositions: result.closedPositions.map(mapClosedPosition),
    wallet: result.wallet
  };
}

export function refreshWallet() {
  return request<BotWallet>("/api/wallet");
}

export function getLogs(limit = 200) {
  return request<BotLog[]>(`/api/logs?limit=${limit}`);
}

export function getTradingStatus() {
  return request<TradingStatus>("/api/trading");
}

export function startTrading() {
  return request<TradingStatus>("/api/trading/start", {
    method: "POST"
  });
}

export function stopTrading() {
  return request<TradingStatus>("/api/trading/stop", {
    method: "POST"
  });
}

export function saveSettings(settings: Partial<ApiSettings>) {
  return request<ApiSettings>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(settings)
  });
}

export function addTrackedTrader(address: string) {
  return request<Trader[]>("/api/traders", {
    method: "POST",
    body: JSON.stringify({ address })
  });
}

export function deleteTrackedTrader(address: string) {
  return request<Trader[]>(`/api/traders/${address}`, {
    method: "DELETE"
  });
}
