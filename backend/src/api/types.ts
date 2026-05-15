export type TrackedTrader = {
  address: string;
  label?: string;
  enabled: boolean;
  createdAt: string;
};

export type BotSettings = {
  profitTargetMultiplier: number;
  stopLossMultiplier: number;
  positionTimeoutMinutes: number;
  buyAmountSol: number;
};

export type PlatformName = "Raydium" | "Orca" | "Meteora" | "Pump.fun" | "PumpSwap" | "Jupiter";

export type ActivePosition = {
  id: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenMint: string;
  tokenImage?: string;
  sourceTrader: string;
  buyPlatform: PlatformName;
  buyTx?: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  amountUsd: number;
  solSpent?: number;
  tokenAmount: number;
  openedAt: string;
  status: "open" | "selling";
};

export type CloseReason = "take-profit" | "manual" | "stop-loss" | "timeout";

export type ClosedPosition = Omit<ActivePosition, "status" | "currentPriceUsd"> & {
  exitPriceUsd: number;
  exitPlatform: PlatformName;
  closedAt: string;
  closeReason: CloseReason;
  sellTx?: string;
};

export type BotWalletSnapshot = {
  address: string;
  solBalance: number;
  solPriceUsd: number;
  realizedPnlTodayUsd: number;
  lastUpdated: string;
};

export type BotLogLevel = "info" | "warn" | "error";

export type BotLog = {
  id: string;
  level: BotLogLevel;
  event: string;
  message: string;
  wallet?: string;
  trader?: string;
  tokenMint?: string;
  signature?: string;
  positionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type ApiState = {
  settings: BotSettings;
  trackedTraders: TrackedTrader[];
  activePositions: ActivePosition[];
  closedPositions: ClosedPosition[];
  wallet: BotWalletSnapshot;
};

export type ApiResponse<T> = {
  data: T;
};

export type ApiErrorResponse = {
  error: {
    message: string;
    code: string;
  };
};
