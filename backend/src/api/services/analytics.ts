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
              -- SOL-denominated unrealized PnL: re-value entry at the CURRENT sol
              -- price so we don't pick up phantom % moves from SOL/USD drift.
              -- current_value_usd = token_amount * current_price_usd  (current SOL price implicit)
              -- entry_value_now   = sol_spent  * current_sol_price_usd
              WHEN token_amount > 0 AND current_price_usd > 0
                THEN token_amount * current_price_usd
                     - sol_spent * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              ELSE 0
            END AS pnl_usd,
            COALESCE(buy_network_fee_sol, 0) + COALESCE(buy_priority_fee_sol, 0) AS fee_sol,
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
              WHEN sell_actual_sol_change IS NOT NULL AND buy_actual_sol_change IS NOT NULL
                -- ATA rent (~0.00204 SOL) is recovered into the wallet when the
                -- token account is closed after sell. Real cash inflow that
                -- previously slipped past PnL → users saw ~$0.17 less profit per
                -- trade than gmgn-style explorers showed.
                THEN (sell_actual_sol_change + buy_actual_sol_change + COALESCE(ata_rent_recovered, 0))
                     * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              WHEN entry_price_usd > 0
                THEN amount_usd * (exit_price_usd / entry_price_usd) - amount_usd
                     + COALESCE(ata_rent_recovered, 0) * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              ELSE 0
            END AS pnl_usd,
            COALESCE(buy_network_fee_sol, 0) + COALESCE(buy_priority_fee_sol, 0)
              + COALESCE(sell_network_fee_sol, 0) + COALESCE(sell_priority_fee_sol, 0) AS fee_sol,
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
              -- See listTraderAnalytics for SOL-drift rationale.
              WHEN token_amount > 0 AND current_price_usd > 0
                THEN token_amount * current_price_usd
                     - sol_spent * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              ELSE 0
            END AS pnl_usd,
            COALESCE(buy_network_fee_sol, 0) + COALESCE(buy_priority_fee_sol, 0) AS fee_sol,
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
              WHEN sell_actual_sol_change IS NOT NULL AND buy_actual_sol_change IS NOT NULL
                -- See listTraderAnalytics for the rent-recovery rationale.
                THEN (sell_actual_sol_change + buy_actual_sol_change + COALESCE(ata_rent_recovered, 0))
                     * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              WHEN entry_price_usd > 0
                THEN amount_usd * (exit_price_usd / entry_price_usd) - amount_usd
                     + COALESCE(ata_rent_recovered, 0) * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              ELSE 0
            END AS pnl_usd,
            COALESCE(buy_network_fee_sol, 0) + COALESCE(buy_priority_fee_sol, 0)
              + COALESCE(sell_network_fee_sol, 0) + COALESCE(sell_priority_fee_sol, 0) AS fee_sol,
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

export type MirrorTraderAnalytics = {
  trader: string;
  label?: string;
  tradeCount: number;
  activeTradeCount: number;
  closedTradeCount: number;
  totalSolSpent: number;
  totalSolReceived: number;
  realizedPnlSol: number;
  /** Mark-to-market PnL of currently-open mirror positions, in SOL. */
  unrealizedPnlSol: number;
  totalPnlSol: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  firstTradeAt: string;
  lastTradeAt: string;
};

type MirrorTraderAnalyticsRow = {
  trader: string;
  label?: string;
  trade_count: number;
  active_trade_count: number;
  closed_trade_count: number;
  total_sol_spent: number;
  total_sol_received: number;
  realized_pnl_sol: number;
  unrealized_pnl_sol: number;
  win_count: number;
  loss_count: number;
  first_trade_at: string;
  last_trade_at: string;
};

export function listMirrorTraderAnalytics(): MirrorTraderAnalytics[] {
  const rows = db
    .prepare(
      `
        SELECT
          trades.mirror_trader AS trader,
          mirror_traders.label AS label,
          COUNT(*) AS trade_count,
          SUM(CASE WHEN trades.status = 'active' THEN 1 ELSE 0 END) AS active_trade_count,
          SUM(CASE WHEN trades.status = 'closed' THEN 1 ELSE 0 END) AS closed_trade_count,
          COALESCE(SUM(trades.sol_spent), 0) AS total_sol_spent,
          COALESCE(SUM(CASE WHEN trades.status = 'closed' THEN trades.sol_received ELSE 0 END), 0) AS total_sol_received,
          COALESCE(SUM(CASE WHEN trades.status = 'closed' THEN trades.pnl_sol ELSE 0 END), 0) AS realized_pnl_sol,
          COALESCE(SUM(CASE WHEN trades.status = 'active' THEN trades.pnl_sol ELSE 0 END), 0) AS unrealized_pnl_sol,
          SUM(CASE WHEN trades.status = 'closed' AND trades.pnl_sol > 0 THEN 1 ELSE 0 END) AS win_count,
          SUM(CASE WHEN trades.status = 'closed' AND trades.pnl_sol <= 0 THEN 1 ELSE 0 END) AS loss_count,
          MIN(trades.opened_at) AS first_trade_at,
          MAX(trades.opened_at) AS last_trade_at
        FROM (
          -- Open mirror positions: mark-to-market unrealized PnL in SOL.
          -- We don't store live current_quoted_sol; derive from current_price_usd
          -- and the cached sol_price_usd (both updated together every ~5s).
          SELECT
            mirror_trader,
            sol_spent,
            0 AS sol_received,
            CASE
              WHEN token_amount > 0 AND current_price_usd > 0
                   AND COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0) > 0
                THEN (token_amount * current_price_usd
                       / (SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'))
                     - sol_spent
              ELSE 0
            END AS pnl_sol,
            opened_at,
            'active' AS status
          FROM mirror_positions
          WHERE status = 'open'
          UNION ALL
          SELECT
            mirror_trader,
            sol_spent,
            COALESCE(sol_received, 0) AS sol_received,
            -- Include ata_rent_recovered: ~0.00204 SOL flows back to wallet when
            -- ATA closes after sell. Was missing → mirror PnL undercounted by
            -- ~0.00204 SOL per trade (e.g. 30 trades = 0.061 SOL ≈ $5 ghost loss).
            COALESCE(sol_received, 0) + COALESCE(ata_rent_recovered, 0) - sol_spent AS pnl_sol,
            opened_at,
            'closed' AS status
          FROM mirror_closed_positions
        ) trades
        LEFT JOIN mirror_traders ON mirror_traders.address = trades.mirror_trader
        GROUP BY trades.mirror_trader, mirror_traders.label
        ORDER BY realized_pnl_sol DESC, total_sol_spent DESC, trade_count DESC, last_trade_at DESC
      `
    )
    .all() as MirrorTraderAnalyticsRow[];

  return rows.map((row) => {
    const closedTradeCount = Number(row.closed_trade_count || 0);
    const winCount = Number(row.win_count || 0);
    const realizedPnlSol = Number(row.realized_pnl_sol || 0);
    const unrealizedPnlSol = Number(row.unrealized_pnl_sol || 0);

    return {
      trader: row.trader,
      label: row.label || undefined,
      tradeCount: Number(row.trade_count || 0),
      activeTradeCount: Number(row.active_trade_count || 0),
      closedTradeCount,
      totalSolSpent: Number(row.total_sol_spent || 0),
      totalSolReceived: Number(row.total_sol_received || 0),
      realizedPnlSol,
      unrealizedPnlSol,
      totalPnlSol: realizedPnlSol + unrealizedPnlSol,
      winCount,
      lossCount: Number(row.loss_count || 0),
      winRate: closedTradeCount > 0 ? (winCount / closedTradeCount) * 100 : 0,
      firstTradeAt: row.first_trade_at,
      lastTradeAt: row.last_trade_at
    };
  });
}

export function listSalesAnalytics(bucket: "day" | "hour" = "day"): SalesAnalyticsBucket[] {
  const bucketExpression =
    bucket === "hour" ? "strftime('%Y-%m-%dT%H:00', closed_at)" : "strftime('%Y-%m-%d', closed_at)";

  // UNION ALL across copy + mirror sales so the chart reflects FULL activity.
  // Before this fix, mirror sales (the trader-mirroring path) were invisible
  // on /api/analytics/sales because the query only hit closed_positions.
  const rows = db
    .prepare(
      `
        SELECT
          ${bucketExpression} AS bucket_start,
          COUNT(*) AS sales_count,
          COALESCE(SUM(gross_sol), 0) AS gross_sol,
          COALESCE(SUM(fee_sol), 0) AS fee_sol,
          COALESCE(SUM(net_sol), 0) AS net_sol,
          COALESCE(SUM(pnl_usd), 0) AS pnl_usd
        FROM (
          -- Copy / manual trades
          SELECT
            closed_at,
            COALESCE(sell_quoted_out_sol, sell_actual_sol_change, 0) AS gross_sol,
            COALESCE(sell_network_fee_sol, 0) + COALESCE(sell_priority_fee_sol, 0) AS fee_sol,
            COALESCE(sell_actual_sol_change, sell_quoted_out_sol, 0) AS net_sol,
            CASE
              WHEN sell_actual_sol_change IS NOT NULL AND buy_actual_sol_change IS NOT NULL
                THEN (sell_actual_sol_change + buy_actual_sol_change + COALESCE(ata_rent_recovered, 0))
                     * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              WHEN entry_price_usd > 0
                THEN amount_usd * (exit_price_usd / entry_price_usd) - amount_usd
                     + COALESCE(ata_rent_recovered, 0) * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0)
              ELSE 0
            END AS pnl_usd
          FROM closed_positions
          WHERE closed_at IS NOT NULL
          UNION ALL
          -- Mirror trades
          SELECT
            closed_at,
            COALESCE(sol_received, 0) AS gross_sol,
            0 AS fee_sol,                            -- mirror_closed_positions doesn't track fees per side
            COALESCE(sol_received, 0) AS net_sol,
            (COALESCE(sol_received, 0) + COALESCE(ata_rent_recovered, 0) - sol_spent)
              * COALESCE((SELECT sol_price_usd FROM bot_wallet WHERE id = 'default'), 0) AS pnl_usd
          FROM mirror_closed_positions
          WHERE closed_at IS NOT NULL
        )
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
