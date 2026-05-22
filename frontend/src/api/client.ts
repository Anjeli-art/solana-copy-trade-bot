import type { BotLog, BotWallet, ClosedPosition, ManualTokenAnalytics, Position, Trader, TraderAnalytics } from "../types";

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
  tokenName?: string;
  tokenMint: string;
  tokenImage?: string;
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

export type TokenMetadata = {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  decimals?: number;
  isToken2022: boolean;
  source: "helius";
  fetchedAt: string;
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
  copyEnabled: boolean;
  profitEnabled: boolean;
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
    tokenName: position.tokenName,
    tokenMint: position.tokenMint,
    tokenImage: position.tokenImage,
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
    tokenName: position.tokenName,
    tokenMint: position.tokenMint,
    tokenImage: position.tokenImage,
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

export async function repeatBuyToken(tokenMint: string, amountSol?: number) {
  const result = await request<{
    activePositions: ApiActivePosition[];
    closedPositions: ApiClosedPosition[];
    wallet: BotWallet;
  }>("/api/swap/repeat-buy", {
    method: "POST",
    body: JSON.stringify({ tokenMint, amountSol })
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

export function getTraderAnalytics() {
  return request<TraderAnalytics[]>("/api/analytics/traders");
}

export function getManualTokenAnalytics() {
  return request<ManualTokenAnalytics[]>("/api/analytics/manual-tokens");
}

export function getTokenMetadata(mint: string) {
  return request<TokenMetadata>(`/api/tokens/${encodeURIComponent(mint)}/metadata`);
}

export function deleteLog(id: string) {
  return request<{ id: string }>(`/api/logs/${id}`, {
    method: "DELETE"
  });
}

export function getTradingStatus() {
  return request<TradingStatus>("/api/trading");
}

export function startCopyTrading() {
  return request<TradingStatus>("/api/trading/start-copy", {
    method: "POST"
  });
}

export function stopCopyTrading() {
  return request<TradingStatus>("/api/trading/stop-copy", {
    method: "POST"
  });
}

export function startProfitWatcher() {
  return request<TradingStatus>("/api/trading/start-profit", {
    method: "POST"
  });
}

export function stopProfitWatcher() {
  return request<TradingStatus>("/api/trading/stop-profit", {
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
