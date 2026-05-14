import type { ApiState } from "../types";
import { BOT_WALLET_ADDRESS } from "../constants";

export const defaultState: ApiState = {
  settings: {
    profitTargetMultiplier: 1.5,
    stopLossMultiplier: 0.7,
    positionTimeoutMinutes: 120,
    buyAmountSol: 0.03
  },
  trackedTraders: [],
  activePositions: [],
  closedPositions: [],
  wallet: {
    address: BOT_WALLET_ADDRESS,
    solBalance: 0,
    solPriceUsd: 0,
    realizedPnlTodayUsd: 0,
    lastUpdated: new Date().toISOString()
  }
};
