import { db } from "../db/sqlite";

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

type TraderAnalyticsRow = {
  trader: string;
  label?: string;
  trade_count: number;
  active_trade_count: number;
  closed_trade_count: number;
  total_amount_usd: number;
  total_sol_spent: number;
  first_trade_at: string;
  last_trade_at: string;
};

export function listTraderAnalytics(): TraderAnalytics[] {
  const rows = db
    .prepare(
      `
        SELECT
          trades.source_trader AS trader,
          tracked_traders.label AS label,
          COUNT(*) AS trade_count,
          SUM(CASE WHEN trades.position_state = 'active' THEN 1 ELSE 0 END) AS active_trade_count,
          SUM(CASE WHEN trades.position_state = 'closed' THEN 1 ELSE 0 END) AS closed_trade_count,
          COALESCE(SUM(trades.amount_usd), 0) AS total_amount_usd,
          COALESCE(SUM(trades.sol_spent), 0) AS total_sol_spent,
          MIN(trades.opened_at) AS first_trade_at,
          MAX(trades.opened_at) AS last_trade_at
        FROM (
          SELECT source_trader, amount_usd, sol_spent, opened_at, 'active' AS position_state
          FROM active_positions
          UNION ALL
          SELECT source_trader, amount_usd, sol_spent, opened_at, 'closed' AS position_state
          FROM closed_positions
        ) trades
        LEFT JOIN tracked_traders ON tracked_traders.address = trades.source_trader
        GROUP BY trades.source_trader, tracked_traders.label
        ORDER BY total_amount_usd DESC, trade_count DESC, last_trade_at DESC
      `
    )
    .all() as TraderAnalyticsRow[];

  return rows.map((row) => ({
    trader: row.trader,
    label: row.label || undefined,
    tradeCount: Number(row.trade_count || 0),
    activeTradeCount: Number(row.active_trade_count || 0),
    closedTradeCount: Number(row.closed_trade_count || 0),
    totalAmountUsd: Number(row.total_amount_usd || 0),
    totalSolSpent: Number(row.total_sol_spent || 0),
    firstTradeAt: row.first_trade_at,
    lastTradeAt: row.last_trade_at
  }));
}
