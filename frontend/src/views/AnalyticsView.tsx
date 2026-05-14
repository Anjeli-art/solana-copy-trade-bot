import { BarChart3, Wallet } from "lucide-react";
import type { TraderAnalytics } from "../types";
import { formatNumber, formatSol, formatUsd, shortAddress } from "../utils/format";

type AnalyticsViewProps = {
  traders: TraderAnalytics[];
};

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function AnalyticsView({ traders }: AnalyticsViewProps) {
  const totalAmountUsd = traders.reduce((sum, trader) => sum + trader.totalAmountUsd, 0);
  const totalTrades = traders.reduce((sum, trader) => sum + trader.tradeCount, 0);

  return (
    <section className="analytics-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">Trading history</p>
          <h2>Trader analytics</h2>
        </div>
        <div className="analytics-summary">
          <span>{formatUsd(totalAmountUsd)}</span>
          <strong>{formatNumber(totalTrades)} trades</strong>
        </div>
      </div>

      {traders.length === 0 ? (
        <div className="empty-state">No trader activity yet</div>
      ) : (
        <div className="analytics-table">
          <div className="analytics-row analytics-head">
            <span>Trader</span>
            <span>Trades</span>
            <span>Amount</span>
            <span>SOL</span>
            <span>Last trade</span>
          </div>
          {traders.map((trader) => (
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
              <div className="analytics-cell">
                <strong>{formatUsd(trader.totalAmountUsd)}</strong>
                <span>total deal size</span>
              </div>
              <div className="analytics-cell">
                <strong>{formatSol(trader.totalSolSpent)}</strong>
                <span>spent</span>
              </div>
              <div className="analytics-cell">
                <strong>{formatDate(trader.lastTradeAt)}</strong>
                <span>first {formatDate(trader.firstTradeAt)}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
