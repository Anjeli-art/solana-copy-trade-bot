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
  amountUsd: number;
  solSpent?: number;
  tokenAmount: number;
  trader: string;
  openedAt: string;
};

export type ClosedPosition = Position & {
  exitPrice: number;
  exitPlatform: string;
  closedAt: string;
  closeReason: "take-profit" | "manual" | "stop-loss" | "timeout";
  sellTx: string;
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
  firstTradeAt: string;
  lastTradeAt: string;
};

export type TraderFormHandler = (event: FormEvent<HTMLFormElement>) => void;
