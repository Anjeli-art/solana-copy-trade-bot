import { formatSol } from "../utils/format";

type MetricsGridProps = {
  openPositions: number;
  traderCount: number;
  takeProfit: number;
  highTakeProfit: number;
  buyAmountSol: number;
  copyEnabled: boolean;
  profitEnabled: boolean;
  mirrorEnabled: boolean;
  mirrorPositions: number;
};

export function MetricsGrid({
  openPositions,
  traderCount,
  takeProfit,
  highTakeProfit,
  buyAmountSol,
  copyEnabled,
  profitEnabled,
  mirrorEnabled,
  mirrorPositions
}: MetricsGridProps) {
  const positionsActive = openPositions > 0 && (copyEnabled || profitEnabled);
  const tradersActive   = traderCount > 0 && (copyEnabled || profitEnabled);
  const profitActive    = profitEnabled;
  const buyActive       = copyEnabled;

  return (
    <section className="panel-grid">
      <article className={`metric${positionsActive ? " metric-mirror-on" : ""}`}>
        <span>Open positions</span>
        <strong>{openPositions}</strong>
      </article>
      <article className={`metric${tradersActive ? " metric-mirror-on" : ""}`}>
        <span>Tracked traders</span>
        <strong>{traderCount}</strong>
      </article>
      <article className={`metric${profitActive ? " metric-mirror-on" : ""}`}>
        <span>Profit tiers</span>
        <strong>{takeProfit.toFixed(2)}x / {highTakeProfit.toFixed(2)}x</strong>
      </article>
      <article className={`metric${buyActive ? " metric-mirror-on" : ""}`}>
        <span>Buy amount</span>
        <strong>{formatSol(buyAmountSol)} SOL</strong>
      </article>
      <article className={`metric metric-mirror${mirrorEnabled ? " metric-mirror-on" : ""}`}>
        <span>Mirror</span>
        <strong>{mirrorEnabled ? "Running" : "Off"}</strong>
        {mirrorEnabled && mirrorPositions > 0 && (
          <em>{mirrorPositions} open</em>
        )}
      </article>
    </section>
  );
}
