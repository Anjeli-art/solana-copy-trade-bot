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
  profit_pnl_usd: number;
  loss_pnl_usd: number;
  total_fee_sol: number;
  total_fee_usd: number;
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
  profit_pnl_usd: number;
  loss_pnl_usd: number;
  total_fee_sol: number;
  total_fee_usd: number;
  win_count: number;
  loss_count: number;
  first_trade_at: string;
  last_trade_at: string;
};

type SalesAnalyticsRow = {
  bucket_start: string;
  sales_count: number;
  gross_sol: number;
  fee_sol: number;
  net_sol: number;
  pnl_usd: number;
};

function formatSalesLabel(bucketStart: string, bucket: "day" | "hour") {
  const date = new Date(bucket === "day" ? `${bucketStart}T00:00:00.000Z` : `${bucketStart}:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return bucketStart;
  }

  return bucket === "day"
    ? date.toLocaleDateString([], { day: "2-digit", month: "2-digit" })
    : date.toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit" });
}

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
          COALESCE(SUM(CASE WHEN trades.pnl_usd > 0 THEN trades.pnl_usd ELSE 0 END), 0) AS profit_pnl_usd,
          COALESCE(SUM(CASE WHEN trades.pnl_usd < 0 THEN trades.pnl_usd ELSE 0 END), 0) AS loss_pnl_usd,
          COALESCE(SUM(trades.fee_sol), 0) AS total_fee_sol,
          COALESCE(SUM(trades.fee_sol), 0) * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0) AS total_fee_usd,
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
            COALESCE(buy_network_fee_sol, 0) AS fee_sol,
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
            COALESCE(buy_network_fee_sol, 0) + COALESCE(sell_network_fee_sol, 0) AS fee_sol,
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
      profitPnlUsd: Number(row.profit_pnl_usd || 0),
      lossPnlUsd: Number(row.loss_pnl_usd || 0),
      totalFeeSol: Number(row.total_fee_sol || 0),
      totalFeeUsd: Number(row.total_fee_usd || 0),
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
          COALESCE(SUM(CASE WHEN trades.pnl_usd > 0 THEN trades.pnl_usd ELSE 0 END), 0) AS profit_pnl_usd,
          COALESCE(SUM(CASE WHEN trades.pnl_usd < 0 THEN trades.pnl_usd ELSE 0 END), 0) AS loss_pnl_usd,
          COALESCE(SUM(trades.fee_sol), 0) AS total_fee_sol,
          COALESCE(SUM(trades.fee_sol), 0) * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0) AS total_fee_usd,
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
            COALESCE(buy_network_fee_sol, 0) AS fee_sol,
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
            COALESCE(buy_network_fee_sol, 0) + COALESCE(sell_network_fee_sol, 0) AS fee_sol,
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
      profitPnlUsd: Number(row.profit_pnl_usd || 0),
      lossPnlUsd: Number(row.loss_pnl_usd || 0),
      totalFeeSol: Number(row.total_fee_sol || 0),
      totalFeeUsd: Number(row.total_fee_usd || 0),
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

export function listSalesAnalytics(bucket: "day" | "hour" = "day"): SalesAnalyticsBucket[] {
  const bucketExpression =
    bucket === "hour" ? "strftime('%Y-%m-%dT%H:00', closed_at)" : "strftime('%Y-%m-%d', closed_at)";

  const rows = db
    .prepare(
      `
        SELECT
          ${bucketExpression} AS bucket_start,
          COUNT(*) AS sales_count,
          COALESCE(SUM(COALESCE(sell_quoted_out_sol, sell_actual_sol_change, 0)), 0) AS gross_sol,
          COALESCE(SUM(COALESCE(sell_network_fee_sol, 0)), 0) AS fee_sol,
          COALESCE(SUM(COALESCE(sell_actual_sol_change, sell_quoted_out_sol, 0)), 0) AS net_sol,
          COALESCE(SUM(
            CASE
              WHEN entry_price_usd > 0 THEN amount_usd * (exit_price_usd / entry_price_usd) - amount_usd
              ELSE 0
            END
          ), 0) AS pnl_usd
        FROM closed_positions
        WHERE closed_at IS NOT NULL
        GROUP BY bucket_start
        ORDER BY bucket_start ASC
      `
    )
    .all() as SalesAnalyticsRow[];

  return rows.map((row) => ({
    bucketStart: row.bucket_start,
    label: formatSalesLabel(row.bucket_start, bucket),
    salesCount: Number(row.sales_count || 0),
    grossSol: Number(row.gross_sol || 0),
    feeSol: Number(row.fee_sol || 0),
    netSol: Number(row.net_sol || 0),
    pnlUsd: Number(row.pnl_usd || 0)
  }));
}
