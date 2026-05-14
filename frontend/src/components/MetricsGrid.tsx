import { formatSol } from "../utils/format";

type MetricsGridProps = {
  openPositions: number;
  traderCount: number;
  takeProfit: number;
  buyAmountSol: number;
};

export function MetricsGrid({ openPositions, traderCount, takeProfit, buyAmountSol }: MetricsGridProps) {
  return (
    <section className="panel-grid">
      <article className="metric">
        <span>Open positions</span>
        <strong>{openPositions}</strong>
      </article>
      <article className="metric">
        <span>Tracked traders</span>
        <strong>{traderCount}</strong>
      </article>
      <article className="metric">
        <span>Take profit</span>
        <strong>{takeProfit.toFixed(2)}x</strong>
      </article>
      <article className="metric">
        <span>Buy amount</span>
        <strong>{formatSol(buyAmountSol)} SOL</strong>
      </article>
    </section>
  );
}
