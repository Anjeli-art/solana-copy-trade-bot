import type { FormEvent } from "react";

export type Trader = {
  address: string;
  label?: string;
  enabled?: boolean;
  createdAt: string;
};

export type View = "dashboard" | "positions" | "traders" | "analytics" | "logs";

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
  openedAt: string;
  profitTier: "low" | "high";
};

export type ClosedPosition = Position & {
  exitPrice: number;
  exitPlatform: string;
  closedAt: string;
  closeReason: "take-profit" | "manual" | "stop-loss" | "timeout";
  sellTx: string;
  sellNetworkFeeSol?: number;
  sellPriorityFeeSol?: number;
  sellQuotedOutSol?: number;
  sellActualSolChange?: number;
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
