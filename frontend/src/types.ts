import type { FormEvent } from "react";

export type PlatformName = "Raydium" | "Orca" | "Meteora" | "Pump.fun" | "PumpSwap" | "Jupiter";

export type Trader = {
  address: string;
  label?: string;
  enabled?: boolean;
  createdAt: string;
};

export type View = "dashboard" | "positions" | "traders" | "analytics" | "logs" | "mirror";

export type BotWallet = {
  address: string;
  solBalance: number;
  solPriceUsd: number;
  realizedPnlTodayUsd: number;
  lastUpdated: string;
};

export type Position = {
  id: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenMint: string;
  tokenImage?: string;
  platform: string;
  entryPrice: number;
  currentPrice: number;
  priceUpdatedAt?: string;
  amountUsd: number;
  solSpent?: number;
  buyNetworkFeeSol?: number;
  buyPriorityFeeSol?: number;
  buyQuotedOutAmount?: number;
  buyActualSolChange?: number;
  tokenAmount: number;
  trader: string;
  sourceSignature?: string;
  openedAt: string;
  profitTier: "low" | "high";
};

export type ClosedPosition = Position & {
  exitPrice: number;
  exitPlatform: string;
  closedAt: string;
  closeReason: "take-profit" | "manual" | "stop-loss" | "timeout" | "deleted";
  sellTx: string;
  sellNetworkFeeSol?: number;
  sellPriorityFeeSol?: number;
  sellQuotedOutSol?: number;
  sellActualSolChange?: number;
  // SOL returned when the empty token ATA was closed after this sell.
  // Treated as a credit when computing user-visible PnL (rent is a deposit, not a cost).
  ataRentRecovered?: number;
};

export type ManualRepeatToken = {
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenImage?: string;
  platform: string;
};

export type BlacklistedToken = {
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenImage?: string;
  reason?: string;
  createdAt: string;
};

export type ClosedFilter = "today" | "week" | "month" | "custom" | "all";

export type BotLog = {
  id: string;
  level: "info" | "warn" | "error";
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

export type TraderAnalytics = {
  trader: string;
  label?: string;
  tradeCount: number;
  activeTradeCount: number;
  closedTradeCount: number;
  totalAmountUsd: number;
  totalSolSpent: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  profitPnlUsd: number;
  lossPnlUsd: number;
  totalFeeSol: number;
  totalFeeUsd: number;
  totalPnlPercent: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  averagePnlUsd: number;
  firstTradeAt: string;
  lastTradeAt: string;
};

export type ManualTokenAnalytics = {
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenImage?: string;
  tradeCount: number;
  activeTradeCount: number;
  closedTradeCount: number;
  totalAmountUsd: number;
  totalSolSpent: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  profitPnlUsd: number;
  lossPnlUsd: number;
  totalFeeSol: number;
  totalFeeUsd: number;
  totalPnlPercent: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  averagePnlUsd: number;
  firstTradeAt: string;
  lastTradeAt: string;
};

export type SalesAnalyticsBucket = {
  bucketStart: string;
  label: string;
  salesCount: number;
  grossSol: number;
  feeSol: number;
  netSol: number;
  pnlUsd: number;
};

export type TraderFormHandler = (event: FormEvent<HTMLFormElement>) => void;

export type MirrorTraderAnalytics = {
  trader: string;
  label?: string;
  tradeCount: number;
  activeTradeCount: number;
  closedTradeCount: number;
  totalSolSpent: number;
  totalSolReceived: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  firstTradeAt: string;
  lastTradeAt: string;
};

export type MirrorTrader = {
  address: string;
  label?: string;
  enabled: boolean;
  buyAmountSol: number;
  createdAt: string;
  updatedAt: string;
};

export type MirrorPosition = {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenImage?: string;
  mirrorTrader: string;
  sourceBuySignature?: string;
  buyTx?: string;
  // Where the trader originally bought the token (and where we mirrored from).
  buyPlatform?: PlatformName | null;
  // Which native monitor pipeline is feeding live price for this position.
  monitorType?: "pumpswap" | "pumpfun" | "raydium_amm_v4" | "raydium_cpmm" | "raydium_clmm" | null;
  entryPriceUsd: number;
  currentPriceUsd: number;
  tokenAmount: number;
  solSpent: number;
  openedAt: string;
  status: string;
};

export type MirrorClosedPosition = {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenImage?: string;
  mirrorTrader: string;
  sourceBuySignature?: string;
  sourceSellSignature?: string;
  buyTx?: string;
  sellTx?: string;
  // Where the position was originally opened (e.g. "PumpSwap", "Pump.fun").
  buyPlatform?: PlatformName | string | null;
  // Which venue actually ran the sell ("PumpSwap", "Jupiter", etc.).
  exitPlatform?: string | null;
  entryPriceUsd: number;
  exitPriceUsd: number;
  tokenAmount: number;
  solSpent: number;
  solReceived?: number;
  // SOL returned when we closed the empty token ATA after the sell.
  // Treated as a credit when computing the user-visible PnL — rent is a deposit, not a cost.
  ataRentRecovered?: number;
  closeReason: string;
  openedAt: string;
  closedAt: string;
};

export type MirrorStatus = {
  enabled: boolean;
  mirrorEnabled: boolean;
  processes: Array<{ name: string; pid?: number }>;
};
