import { db } from "../db/sqlite";

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
  totalPnlPercent: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  averagePnlUsd: number;
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
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  total_pnl_usd: number;
  win_count: number;
  loss_count: number;
  first_trade_at: string;
  last_trade_at: string;
};

type ManualTokenAnalyticsRow = {
  token_mint: string;
  token_symbol: string;
  token_name: string | null;
  token_image: string | null;
  trade_count: number;
  active_trade_count: number;
  closed_trade_count: number;
  total_amount_usd: number;
  total_sol_spent: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  total_pnl_usd: number;
  win_count: number;
  loss_count: number;
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
          COALESCE(SUM(CASE WHEN trades.position_state = 'closed' THEN trades.pnl_usd ELSE 0 END), 0) AS realized_pnl_usd,
          COALESCE(SUM(CASE WHEN trades.position_state = 'active' THEN trades.pnl_usd ELSE 0 END), 0) AS unrealized_pnl_usd,
          COALESCE(SUM(trades.pnl_usd), 0) AS total_pnl_usd,
          SUM(CASE WHEN trades.position_state = 'closed' AND trades.pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
          SUM(CASE WHEN trades.position_state = 'closed' AND trades.pnl_usd < 0 THEN 1 ELSE 0 END) AS loss_count,
          MIN(trades.opened_at) AS first_trade_at,
          MAX(trades.opened_at) AS last_trade_at
        FROM (
          SELECT
            source_trader,
            amount_usd,
            sol_spent,
            opened_at,
            CASE
              WHEN entry_price_usd > 0 THEN amount_usd * (current_price_usd / entry_price_usd) - amount_usd
              ELSE 0
            END AS pnl_usd,
            'active' AS position_state
          FROM active_positions
          WHERE source_trader NOT IN ('manual', 'manual-repeat')
          UNION ALL
          SELECT
            source_trader,
            amount_usd,
            sol_spent,
            opened_at,
            CASE
              WHEN entry_price_usd > 0 THEN amount_usd * (exit_price_usd / entry_price_usd) - amount_usd
              ELSE 0
            END AS pnl_usd,
            'closed' AS position_state
          FROM closed_positions
          WHERE source_trader NOT IN ('manual', 'manual-repeat')
        ) trades
        LEFT JOIN tracked_traders ON tracked_traders.address = trades.source_trader
        GROUP BY trades.source_trader, tracked_traders.label
        ORDER BY total_pnl_usd DESC, total_amount_usd DESC, trade_count DESC, last_trade_at DESC
      `
    )
    .all() as TraderAnalyticsRow[];

  return rows.map((row) => {
    const tradeCount = Number(row.trade_count || 0);
    const closedTradeCount = Number(row.closed_trade_count || 0);
    const totalAmountUsd = Number(row.total_amount_usd || 0);
    const totalPnlUsd = Number(row.total_pnl_usd || 0);
    const winCount = Number(row.win_count || 0);

    return {
      trader: row.trader,
      label: row.label || undefined,
      tradeCount,
      activeTradeCount: Number(row.active_trade_count || 0),
      closedTradeCount,
      totalAmountUsd,
      totalSolSpent: Number(row.total_sol_spent || 0),
      realizedPnlUsd: Number(row.realized_pnl_usd || 0),
      unrealizedPnlUsd: Number(row.unrealized_pnl_usd || 0),
      totalPnlUsd,
      totalPnlPercent: totalAmountUsd > 0 ? (totalPnlUsd / totalAmountUsd) * 100 : 0,
      winCount,
      lossCount: Number(row.loss_count || 0),
      winRate: closedTradeCount > 0 ? (winCount / closedTradeCount) * 100 : 0,
      averagePnlUsd: tradeCount > 0 ? totalPnlUsd / tradeCount : 0,
      firstTradeAt: row.first_trade_at,
      lastTradeAt: row.last_trade_at
    };
  });
}

export function listManualTokenAnalytics(): ManualTokenAnalytics[] {
  const rows = db
    .prepare(
      `
        SELECT
          trades.token_mint,
          COALESCE(token_metadata.symbol, MAX(trades.token_symbol)) AS token_symbol,
          token_metadata.name AS token_name,
          token_metadata.image AS token_image,
          COUNT(*) AS trade_count,
          SUM(CASE WHEN trades.position_state = 'active' THEN 1 ELSE 0 END) AS active_trade_count,
          SUM(CASE WHEN trades.position_state = 'closed' THEN 1 ELSE 0 END) AS closed_trade_count,
          COALESCE(SUM(trades.amount_usd), 0) AS total_amount_usd,
          COALESCE(SUM(trades.sol_spent), 0) AS total_sol_spent,
          COALESCE(SUM(CASE WHEN trades.position_state = 'closed' THEN trades.pnl_usd ELSE 0 END), 0) AS realized_pnl_usd,
          COALESCE(SUM(CASE WHEN trades.position_state = 'active' THEN trades.pnl_usd ELSE 0 END), 0) AS unrealized_pnl_usd,
          COALESCE(SUM(trades.pnl_usd), 0) AS total_pnl_usd,
          SUM(CASE WHEN trades.position_state = 'closed' AND trades.pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
          SUM(CASE WHEN trades.position_state = 'closed' AND trades.pnl_usd < 0 THEN 1 ELSE 0 END) AS loss_count,
          MIN(trades.opened_at) AS first_trade_at,
          MAX(trades.opened_at) AS last_trade_at
        FROM (
          SELECT
            token_symbol,
            token_mint,
            amount_usd,
            sol_spent,
            opened_at,
            CASE
              WHEN entry_price_usd > 0 THEN amount_usd * (current_price_usd / entry_price_usd) - amount_usd
              ELSE 0
            END AS pnl_usd,
            'active' AS position_state
          FROM active_positions
          WHERE source_trader IN ('manual', 'manual-repeat')
          UNION ALL
          SELECT
            token_symbol,
            token_mint,
            amount_usd,
            sol_spent,
            opened_at,
            CASE
              WHEN entry_price_usd > 0 THEN amount_usd * (exit_price_usd / entry_price_usd) - amount_usd
              ELSE 0
            END AS pnl_usd,
            'closed' AS position_state
          FROM closed_positions
          WHERE source_trader IN ('manual', 'manual-repeat')
        ) trades
        LEFT JOIN token_metadata ON token_metadata.mint = trades.token_mint
        GROUP BY trades.token_mint, token_metadata.symbol, token_metadata.name, token_metadata.image
        ORDER BY total_pnl_usd DESC, total_amount_usd DESC, last_trade_at DESC
      `
    )
    .all() as ManualTokenAnalyticsRow[];

  return rows.map((row) => {
    const tradeCount = Number(row.trade_count || 0);
    const closedTradeCount = Number(row.closed_trade_count || 0);
    const totalAmountUsd = Number(row.total_amount_usd || 0);
    const totalPnlUsd = Number(row.total_pnl_usd || 0);
    const winCount = Number(row.win_count || 0);

    return {
      tokenMint: row.token_mint,
      tokenSymbol: row.token_symbol,
      tokenName: row.token_name || undefined,
      tokenImage: row.token_image || undefined,
      tradeCount,
      activeTradeCount: Number(row.active_trade_count || 0),
      closedTradeCount,
      totalAmountUsd,
      totalSolSpent: Number(row.total_sol_spent || 0),
      realizedPnlUsd: Number(row.realized_pnl_usd || 0),
      unrealizedPnlUsd: Number(row.unrealized_pnl_usd || 0),
      totalPnlUsd,
      totalPnlPercent: totalAmountUsd > 0 ? (totalPnlUsd / totalAmountUsd) * 100 : 0,
      winCount,
      lossCount: Number(row.loss_count || 0),
      winRate: closedTradeCount > 0 ? (winCount / closedTradeCount) * 100 : 0,
      averagePnlUsd: tradeCount > 0 ? totalPnlUsd / tradeCount : 0,
      firstTradeAt: row.first_trade_at,
      lastTradeAt: row.last_trade_at
    };
  });
}
