import type {
  BotLog,
  BotWallet,
  BlacklistedToken,
  ClosedPosition,
  ManualRepeatToken,
  ManualTokenAnalytics,
  MirrorClosedPosition,
  MirrorPosition,
  MirrorStatus,
  MirrorTrader,
  MirrorTraderAnalytics,
  Position,
  SalesAnalyticsBucket,
  Trader,
  TraderAnalytics
} from "../types";

type ApiResponse<T> = {
  data: T;
};

type ApiSettings = {
  profitTargetMultiplier: number;
  highProfitTargetMultiplier: number;
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
  sourceSignature?: string;
  buyPlatform: string;
  buyTx?: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  currentPriceUpdatedAt?: string;
  amountUsd: number;
  solSpent?: number;
  buyNetworkFeeSol?: number;
  buyPriorityFeeSol?: number;
  buyQuotedOutAmount?: number;
  buyActualSolChange?: number;
  tokenAmount: number;
  openedAt: string;
  status: "open" | "selling";
  profitTier?: "low" | "high";
};

type ApiClosedPosition = Omit<ApiActivePosition, "currentPriceUsd" | "status"> & {
  exitPriceUsd: number;
  exitPlatform: string;
  closedAt: string;
  closeReason: "take-profit" | "manual" | "stop-loss" | "timeout" | "deleted";
  sellTx?: string;
  sellNetworkFeeSol?: number;
  sellPriorityFeeSol?: number;
  sellQuotedOutSol?: number;
  sellActualSolChange?: number;
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
    name: "copy" | "profit-low" | "profit-high";
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
    priceUpdatedAt: position.currentPriceUpdatedAt,
    amountUsd: position.amountUsd,
    solSpent: position.solSpent,
    buyNetworkFeeSol: position.buyNetworkFeeSol,
    buyPriorityFeeSol: position.buyPriorityFeeSol,
    buyQuotedOutAmount: position.buyQuotedOutAmount,
    buyActualSolChange: position.buyActualSolChange,
    tokenAmount: position.tokenAmount,
    trader: position.sourceTrader,
    sourceSignature: position.sourceSignature,
    openedAt: position.openedAt,
    profitTier: position.profitTier === "high" ? "high" : "low"
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
    buyNetworkFeeSol: position.buyNetworkFeeSol,
    buyPriorityFeeSol: position.buyPriorityFeeSol,
    buyQuotedOutAmount: position.buyQuotedOutAmount,
    buyActualSolChange: position.buyActualSolChange,
    tokenAmount: position.tokenAmount,
    trader: position.sourceTrader,
    openedAt: position.openedAt,
    profitTier: position.profitTier === "high" ? "high" : "low",
    exitPrice: position.exitPriceUsd,
    exitPlatform: position.exitPlatform,
    closedAt: position.closedAt,
    closeReason: position.closeReason,
    sellTx: position.sellTx || "",
    sellNetworkFeeSol: position.sellNetworkFeeSol,
    sellPriorityFeeSol: position.sellPriorityFeeSol,
    sellQuotedOutSol: position.sellQuotedOutSol,
    sellActualSolChange: position.sellActualSolChange
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

export function updatePositionProfitTier(id: string, profitTier: "low" | "high") {
  return request<ApiActivePosition[]>(`/api/positions/active/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ profitTier })
  }).then((positions) => positions.map(mapActivePosition));
}

export function getManualRepeatTokens() {
  return request<ManualRepeatToken[]>("/api/manual-tokens");
}

export function deleteManualRepeatToken(tokenMint: string) {
  return request<{ tokenMint: string }>(`/api/manual-tokens/${encodeURIComponent(tokenMint)}`, {
    method: "DELETE"
  });
}

export function getBlacklistedTokens() {
  return request<BlacklistedToken[]>("/api/blacklist");
}

export function addBlacklistedToken(tokenMint: string, reason?: string) {
  return request<BlacklistedToken[]>("/api/blacklist", {
    method: "POST",
    body: JSON.stringify({ tokenMint, reason })
  });
}

export function deleteBlacklistedToken(tokenMint: string) {
  return request<{ tokenMint: string }>(`/api/blacklist/${encodeURIComponent(tokenMint)}`, {
    method: "DELETE"
  });
}

export function refreshWallet() {
  return request<BotWallet>("/api/wallet");
}

export function getLogs(limit = 200, event?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (event) {
    params.set("event", event);
  }

  return request<BotLog[]>(`/api/logs?${params.toString()}`);
}

export function getLogEvents() {
  return request<string[]>("/api/logs/events");
}

export function getTraderAnalytics() {
  return request<TraderAnalytics[]>("/api/analytics/traders");
}

export function getManualTokenAnalytics() {
  return request<ManualTokenAnalytics[]>("/api/analytics/manual-tokens");
}

export function getSalesAnalytics(bucket: "day" | "hour") {
  return request<SalesAnalyticsBucket[]>(`/api/analytics/sales?bucket=${bucket}`);
}

export function getMirrorTraderAnalytics() {
  return request<MirrorTraderAnalytics[]>("/api/analytics/mirror-traders");
}

export function getTokenMetadata(mint: string) {
  return request<TokenMetadata>(`/api/tokens/${encodeURIComponent(mint)}/metadata`);
}

export function deleteLog(id: string) {
  return request<{ id: string }>(`/api/logs/${id}`, {
    method: "DELETE"
  });
}

export function deleteLogsByEvent(event: string) {
  return request<{ deleted: number; event: string }>(`/api/logs?event=${encodeURIComponent(event)}`, {
    method: "DELETE"
  });
}

export function deleteAllLogs() {
  return request<{ deleted: number }>("/api/logs", {
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

export function patchTrackedTrader(address: string, patch: { enabled?: boolean; label?: string }) {
  return request<Trader[]>(`/api/traders/${address}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export type AverageDownPreview = {
  dcaSol: number;
  currentMultiplier: number;
  targetMultiplier: number;
  newAvgEntryUsd: number;
  breakEvenRecoveryPct: number;
  takeProfitRecoveryPct: number;
  newSolSpent: number;
  newTokenAmount: number;
};

export function getAverageDownPreview(positionId: string) {
  return request<AverageDownPreview>(`/api/positions/active/${positionId}/average-down`);
}

// Mirror trading
export function getMirrorStatus() {
  return request<MirrorStatus>("/api/mirror/status");
}

export function startMirrorTrading() {
  return request<MirrorStatus>("/api/mirror/start", { method: "POST" });
}

export function stopMirrorTrading() {
  return request<MirrorStatus>("/api/mirror/stop", { method: "POST" });
}

export function getMirrorTraders() {
  return request<MirrorTrader[]>("/api/mirror/traders");
}

export function addMirrorTrader(address: string, label?: string, buyAmountSol?: number) {
  return request<MirrorTrader[]>("/api/mirror/traders", {
    method: "POST",
    body: JSON.stringify({ address, label, buyAmountSol })
  });
}

export function patchMirrorTrader(
  address: string,
  patch: { label?: string; enabled?: boolean; buyAmountSol?: number }
) {
  return request<MirrorTrader[]>(`/api/mirror/traders/${encodeURIComponent(address)}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export function deleteMirrorTrader(address: string) {
  return request<MirrorTrader[]>(`/api/mirror/traders/${encodeURIComponent(address)}`, {
    method: "DELETE"
  });
}

export function getMirrorPositions() {
  return request<MirrorPosition[]>("/api/mirror/positions");
}

export function getMirrorClosedPositions() {
  return request<MirrorClosedPosition[]>("/api/mirror/positions/closed");
}

export function sellMirrorPosition(id: string) {
  return request<{ positions: MirrorPosition[]; sold: boolean; signature?: string }>(
    `/api/mirror/positions/${encodeURIComponent(id)}/sell`,
    { method: "POST" }
  );
}
