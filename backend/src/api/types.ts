export type TrackedTrader = {
  address: string;
  label?: string;
  enabled: boolean;
  createdAt: string;
};

export type BotSettings = {
  profitTargetMultiplier: number;
  highProfitTargetMultiplier: number;
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
  sourceSignature?: string;
  buyPlatform: PlatformName;
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
  profitTier: "low" | "high";
  // Pool monitoring metadata for real-time WebSocket price feed.
  // Populated only for PumpSwap positions (and future native-monitored platforms).
  // When monitorType is null, price comes from Jupiter polling instead.
  // For PumpSwap & Raydium AMM v4: poolAddress = pool/AMM id, poolBaseVault/poolQuoteVault = token accounts.
  // For Pump.fun bonding curve: poolAddress = bonding curve PDA, vaults are null
  //   (reserves live inside the bonding curve account itself).
  poolAddress?: string;
  poolBaseVault?: string;
  poolQuoteVault?: string;
  poolBaseDecimals?: number;
  monitorType?:
    | "pumpswap"
    | "pumpfun"
    | "raydium_amm_v4"
    | "raydium_cpmm"
    | "raydium_clmm"
    | null;
};

export type CloseReason = "take-profit" | "manual" | "stop-loss" | "timeout" | "deleted";

export type ClosedPosition = Omit<ActivePosition, "status" | "currentPriceUsd"> & {
  exitPriceUsd: number;
  exitPlatform: PlatformName;
  closedAt: string;
  closeReason: CloseReason;
  sellTx?: string;
  sellNetworkFeeSol?: number;
  sellPriorityFeeSol?: number;
  sellQuotedOutSol?: number;
  sellActualSolChange?: number;
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
