import { useState } from "react";
import { BarChart3, Download, Wallet } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { ManualTokenAnalytics, SalesAnalyticsBucket, TraderAnalytics } from "../types";
import { exportAnalyticsToExcel } from "../utils/analyticsExport";
import { formatNumber, formatSol, formatUsd, shortAddress } from "../utils/format";

type AnalyticsViewProps = {
  traders: TraderAnalytics[];
  manualTokens: ManualTokenAnalytics[];
  salesByDay: SalesAnalyticsBucket[];
  salesByHour: SalesAnalyticsBucket[];
};

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatSignedUsd(value: number) {
  return `${value >= 0 ? "+" : ""}${formatUsd(value)}`;
}

function formatSignedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatFeeUsd(value: number) {
  return `-${formatUsd(Math.abs(value))}`;
}

export function AnalyticsView({ traders, manualTokens, salesByDay, salesByHour }: AnalyticsViewProps) {
  const [mode, setMode] = useState<"trading" | "manual">("trading");
  const [salesBucket, setSalesBucket] = useState<"day" | "hour">("day");
  const salesChartData = salesBucket === "day" ? salesByDay : salesByHour;
  const totalAmountUsd = traders.reduce((sum, trader) => sum + trader.totalAmountUsd, 0);
  const totalPnlUsd = traders.reduce((sum, trader) => sum + trader.totalPnlUsd, 0);
  const totalProfitPnlUsd = traders.reduce((sum, trader) => sum + (trader.profitPnlUsd ?? Math.max(trader.totalPnlUsd, 0)), 0);
  const totalLossPnlUsd = traders.reduce((sum, trader) => sum + (trader.lossPnlUsd ?? Math.min(trader.totalPnlUsd, 0)), 0);
  const totalFeeUsd = traders.reduce((sum, trader) => sum + (trader.totalFeeUsd ?? 0), 0);
  const totalPnlPercent = totalAmountUsd > 0 ? (totalPnlUsd / totalAmountUsd) * 100 : 0;
  const totalTrades = traders.reduce((sum, trader) => sum + trader.tradeCount, 0);
  const manualAmountUsd = manualTokens.reduce((sum, token) => sum + token.totalAmountUsd, 0);
  const manualPnlUsd = manualTokens.reduce((sum, token) => sum + token.totalPnlUsd, 0);
  const manualProfitPnlUsd = manualTokens.reduce((sum, token) => sum + (token.profitPnlUsd ?? Math.max(token.totalPnlUsd, 0)), 0);
  const manualLossPnlUsd = manualTokens.reduce((sum, token) => sum + (token.lossPnlUsd ?? Math.min(token.totalPnlUsd, 0)), 0);
  const manualFeeUsd = manualTokens.reduce((sum, token) => sum + (token.totalFeeUsd ?? 0), 0);
  const manualPnlPercent = manualAmountUsd > 0 ? (manualPnlUsd / manualAmountUsd) * 100 : 0;
  const manualTrades = manualTokens.reduce((sum, token) => sum + token.tradeCount, 0);
  const salesChartSection = (
    <section className="analytics-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">Closed sales</p>
          <h2>Sales chart</h2>
        </div>
        <div className="analytics-mode-tabs sales-chart-tabs" role="tablist" aria-label="Sales chart bucket">
          <button
            className={salesBucket === "day" ? "active" : ""}
            type="button"
            onClick={() => setSalesBucket("day")}
          >
            Days
          </button>
          <button
            className={salesBucket === "hour" ? "active" : ""}
            type="button"
            onClick={() => setSalesBucket("hour")}
          >
            Hours
          </button>
        </div>
      </div>
      {salesChartData.length === 0 ? (
        <div className="empty-state">No closed sales yet</div>
      ) : (
        <div className="sales-chart">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={salesChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#e6ece7" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#66746c", fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis
                yAxisId="left"
                tick={{ fill: "#66746c", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={38}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: "#66746c", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={42}
              />
              <Tooltip
                contentStyle={{ border: "1px solid #dbe5dd", borderRadius: 8, color: "#17201b" }}
                formatter={(value, name) => {
                  if (name === "PnL") return [formatUsd(Number(value)), name];
                  if (name === "Net SOL") return [`${formatSol(Number(value))} SOL`, name];
                  if (name === "Fees") return [`${formatSol(Number(value))} SOL`, name];
                  return [formatNumber(Number(value)), name];
                }}
              />
              <Bar yAxisId="left" dataKey="salesCount" name="Sales" fill="#1f714e" radius={[4, 4, 0, 0]} />
              <Line yAxisId="right" type="monotone" dataKey="pnlUsd" name="PnL" stroke="#2e5e8f" strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="feeSol" name="Fees" stroke="#9b2c20" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );

  return (
    <>
      <section className="analytics-section analytics-mode-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Analytics</p>
            <h2>{mode === "trading" ? "Trading analytics" : "Manual analytics"}</h2>
          </div>
          <div className="analytics-mode-actions">
            <button
              className="export-button"
              type="button"
              onClick={() => exportAnalyticsToExcel(traders, manualTokens, mode)}
            >
              <Download size={17} />
              Export
            </button>
            <div className="analytics-mode-tabs" role="tablist" aria-label="Analytics view">
              <button
                className={mode === "trading" ? "active" : ""}
                type="button"
                onClick={() => setMode("trading")}
              >
                Trading
              </button>
              <button
                className={mode === "manual" ? "active" : ""}
                type="button"
                onClick={() => setMode("manual")}
              >
                Manual
              </button>
            </div>
          </div>
        </div>
      </section>

      {mode === "trading" ? (
      <section className="analytics-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Copy trading only</p>
            <h2>Trader analytics</h2>
          </div>
          <div className="analytics-summary">
            <span className={totalPnlUsd >= 0 ? "positive" : "negative"}>{formatSignedUsd(totalPnlUsd)}</span>
            <div className="analytics-summary-breakdown">
              <small className="positive">{formatSignedUsd(totalProfitPnlUsd)}</small>
              <small className="negative">{formatUsd(totalLossPnlUsd)}</small>
              <small className="negative">fees {formatFeeUsd(totalFeeUsd)}</small>
            </div>
            <strong>{formatSignedPercent(totalPnlPercent)} / {formatNumber(totalTrades)} trades</strong>
          </div>
        </div>

        {traders.length === 0 ? (
          <div className="empty-state">No trader activity yet</div>
        ) : (
          <div className="analytics-table">
          <div className="analytics-row analytics-head">
            <span>Trader</span>
            <span>Trades</span>
            <span>PnL</span>
            <span>Win rate</span>
            <span>Volume</span>
            <span>Open PnL</span>
            <span>Last trade</span>
          </div>
          {traders.map((trader) => {
            const pnlClass = trader.totalPnlUsd >= 0 ? "positive" : "negative";
            const openPnlClass = trader.unrealizedPnlUsd >= 0 ? "positive" : "negative";

            return (
              <article className="analytics-row" key={trader.trader}>
                <div className="analytics-trader">
                  <div className="wallet-icon">
                    <Wallet size={18} />
                  </div>
                  <div>
                    <strong title={trader.trader}>{trader.label || shortAddress(trader.trader)}</strong>
                    <span title={trader.trader}>{trader.trader}</span>
                  </div>
                </div>
                <div className="analytics-cell">
                  <strong>{formatNumber(trader.tradeCount)}</strong>
                  <span>
                    {formatNumber(trader.activeTradeCount)} open / {formatNumber(trader.closedTradeCount)} closed
                  </span>
                </div>
                <div className={`analytics-cell ${pnlClass}`}>
                  <strong>{formatSignedUsd(trader.totalPnlUsd)}</strong>
                  <span>{formatSignedPercent(trader.totalPnlPercent)} total</span>
                </div>
                <div className="analytics-cell">
                  <strong>{trader.closedTradeCount > 0 ? `${trader.winRate.toFixed(0)}%` : "-"}</strong>
                  <span>{formatNumber(trader.winCount)} win / {formatNumber(trader.lossCount)} loss</span>
                </div>
                <div className="analytics-cell">
                  <strong>{formatUsd(trader.totalAmountUsd)}</strong>
                  <span>{formatSol(trader.totalSolSpent)} SOL spent</span>
                </div>
                <div className={`analytics-cell ${openPnlClass}`}>
                  <strong>{formatSignedUsd(trader.unrealizedPnlUsd)}</strong>
                  <span>{formatSignedUsd(trader.realizedPnlUsd)} realized</span>
                </div>
                <div className="analytics-cell">
                  <strong>{formatDate(trader.lastTradeAt)}</strong>
                  <span>{formatSignedUsd(trader.averagePnlUsd)} avg</span>
                </div>
              </article>
            );
          })}
          </div>
        )}
      </section>
      ) : null}

      {mode === "manual" ? (
      <section className="analytics-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Manual buys only</p>
            <h2>Manual token analytics</h2>
          </div>
          <div className="analytics-summary">
            <span className={manualPnlUsd >= 0 ? "positive" : "negative"}>{formatSignedUsd(manualPnlUsd)}</span>
            <div className="analytics-summary-breakdown">
              <small className="positive">{formatSignedUsd(manualProfitPnlUsd)}</small>
              <small className="negative">{formatUsd(manualLossPnlUsd)}</small>
              <small className="negative">fees {formatFeeUsd(manualFeeUsd)}</small>
            </div>
            <strong>{formatSignedPercent(manualPnlPercent)} / {formatNumber(manualTrades)} trades</strong>
          </div>
        </div>
        {manualTokens.length === 0 ? (
          <div className="empty-state">No manual buys yet</div>
        ) : (
          <div className="analytics-table">
            <div className="analytics-row analytics-head">
              <span>Token</span>
              <span>Trades</span>
              <span>PnL</span>
              <span>Win rate</span>
              <span>Volume</span>
              <span>Open PnL</span>
              <span>Last trade</span>
            </div>
            {manualTokens.map((token) => {
              const pnlClass = token.totalPnlUsd >= 0 ? "positive" : "negative";
              const openPnlClass = token.unrealizedPnlUsd >= 0 ? "positive" : "negative";

              return (
                <article className="analytics-row" key={token.tokenMint}>
                  <div className="analytics-trader">
                    <div className="wallet-icon">
                      <BarChart3 size={18} />
                    </div>
                    <div>
                      <strong title={token.tokenMint}>{token.tokenName || token.tokenSymbol}</strong>
                      <span title={token.tokenMint}>{token.tokenSymbol} • {token.tokenMint}</span>
                    </div>
                  </div>
                  <div className="analytics-cell">
                    <strong>{formatNumber(token.tradeCount)}</strong>
                    <span>{formatNumber(token.activeTradeCount)} open / {formatNumber(token.closedTradeCount)} closed</span>
                  </div>
                  <div className={`analytics-cell ${pnlClass}`}>
                    <strong>{formatSignedUsd(token.totalPnlUsd)}</strong>
                    <span>{formatSignedPercent(token.totalPnlPercent)} total</span>
                  </div>
                  <div className="analytics-cell">
                    <strong>{token.closedTradeCount > 0 ? `${token.winRate.toFixed(0)}%` : "-"}</strong>
                    <span>{formatNumber(token.winCount)} win / {formatNumber(token.lossCount)} loss</span>
                  </div>
                  <div className="analytics-cell">
                    <strong>{formatUsd(token.totalAmountUsd)}</strong>
                    <span>{formatSol(token.totalSolSpent)} SOL spent</span>
                  </div>
                  <div className={`analytics-cell ${openPnlClass}`}>
                    <strong>{formatSignedUsd(token.unrealizedPnlUsd)}</strong>
                    <span>{formatSignedUsd(token.realizedPnlUsd)} realized</span>
                  </div>
                  <div className="analytics-cell">
                    <strong>{formatDate(token.lastTradeAt)}</strong>
                    <span>{formatSignedUsd(token.averagePnlUsd)} avg</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      ) : null}

      {salesChartSection}
    </>
  );
}
