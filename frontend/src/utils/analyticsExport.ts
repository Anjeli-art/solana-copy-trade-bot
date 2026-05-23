import type { ManualTokenAnalytics, TraderAnalytics } from "../types";

type AnalyticsMode = "trading" | "manual";

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, "\"\"")}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportTraderAnalytics(traders: TraderAnalytics[]) {
  const headers = [
    "Trader",
    "Label",
    "Trades",
    "Open trades",
    "Closed trades",
    "Total PnL USD",
    "Total PnL %",
    "Realized PnL USD",
    "Unrealized PnL USD",
    "Win rate %",
    "Wins",
    "Losses",
    "Volume USD",
    "SOL spent",
    "Average PnL USD",
    "First trade",
    "Last trade"
  ];
  const rows = traders.map((trader) => [
    trader.trader,
    trader.label || "",
    trader.tradeCount,
    trader.activeTradeCount,
    trader.closedTradeCount,
    trader.totalPnlUsd,
    trader.totalPnlPercent.toFixed(2),
    trader.realizedPnlUsd,
    trader.unrealizedPnlUsd,
    trader.winRate.toFixed(2),
    trader.winCount,
    trader.lossCount,
    trader.totalAmountUsd,
    trader.totalSolSpent,
    trader.averagePnlUsd,
    trader.firstTradeAt,
    trader.lastTradeAt
  ]);

  downloadCsv("trader-analytics.csv", headers, rows);
}

function exportManualTokenAnalytics(manualTokens: ManualTokenAnalytics[]) {
  const headers = [
    "Token",
    "Symbol",
    "Mint",
    "Trades",
    "Open trades",
    "Closed trades",
    "Total PnL USD",
    "Total PnL %",
    "Realized PnL USD",
    "Unrealized PnL USD",
    "Win rate %",
    "Wins",
    "Losses",
    "Volume USD",
    "SOL spent",
    "Average PnL USD",
    "First trade",
    "Last trade"
  ];
  const rows = manualTokens.map((token) => [
    token.tokenName || token.tokenSymbol,
    token.tokenSymbol,
    token.tokenMint,
    token.tradeCount,
    token.activeTradeCount,
    token.closedTradeCount,
    token.totalPnlUsd,
    token.totalPnlPercent.toFixed(2),
    token.realizedPnlUsd,
    token.unrealizedPnlUsd,
    token.winRate.toFixed(2),
    token.winCount,
    token.lossCount,
    token.totalAmountUsd,
    token.totalSolSpent,
    token.averagePnlUsd,
    token.firstTradeAt,
    token.lastTradeAt
  ]);

  downloadCsv("manual-token-analytics.csv", headers, rows);
}

export function exportAnalyticsToExcel(
  traders: TraderAnalytics[],
  manualTokens: ManualTokenAnalytics[],
  mode: AnalyticsMode
) {
  if (mode === "manual") {
    exportManualTokenAnalytics(manualTokens);
    return;
  }

  exportTraderAnalytics(traders);
}
