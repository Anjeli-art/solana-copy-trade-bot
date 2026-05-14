import { CircleDollarSign } from "lucide-react";
import type { ClosedPosition, Position } from "../types";
import { formatNumber, formatUsd, shortAddress } from "../utils/format";
import { getPnl } from "../utils/positions";

type PositionRowProps = {
  position: Position;
  onSell?: (id: string) => void;
};

export function PositionRow({ position, onSell }: PositionRowProps) {
  const { pnlPercent, pnlUsd } = getPnl(position);

  return (
    <article className="position-row">
      <div className="token-icon">
        <CircleDollarSign size={18} />
      </div>
      <div className="position-token">
        <strong>{position.tokenSymbol}</strong>
        <span title={position.tokenMint}>{shortAddress(position.tokenMint)}</span>
      </div>
      <div className="position-cell">
        <span>Entry</span>
        <strong>{formatUsd(position.entryPrice)}</strong>
      </div>
      <div className="position-cell">
        <span>Current</span>
        <strong>{formatUsd(position.currentPrice)}</strong>
      </div>
      <div className={`position-pnl ${pnlPercent >= 0 ? "positive" : "negative"}`}>
        <strong>{pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%</strong>
        <span>{pnlUsd >= 0 ? "+" : ""}{formatUsd(pnlUsd)}</span>
      </div>
      <div className="position-cell">
        <span>Amount</span>
        <strong>{formatNumber(position.tokenAmount)}</strong>
      </div>
      <div className="platform-pill">{position.platform}</div>
      <button className="sell-button" type="button" onClick={() => onSell?.(position.id)}>
        Sell
      </button>
    </article>
  );
}

export function ClosedPositionRow({ position }: { position: ClosedPosition }) {
  const { pnlPercent, pnlUsd } = getPnl({
    ...position,
    currentPrice: position.exitPrice
  });

  return (
    <article className="position-row closed">
      <div className="token-icon">
        <CircleDollarSign size={18} />
      </div>
      <div className="position-token">
        <strong>{position.tokenSymbol}</strong>
        <span title={position.tokenMint}>{shortAddress(position.tokenMint)}</span>
      </div>
      <div className="position-cell">
        <span>Entry</span>
        <strong>{formatUsd(position.entryPrice)}</strong>
      </div>
      <div className="position-cell">
        <span>Exit</span>
        <strong>{formatUsd(position.exitPrice)}</strong>
      </div>
      <div className={`position-pnl ${pnlPercent >= 0 ? "positive" : "negative"}`}>
        <strong>{pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%</strong>
        <span>{pnlUsd >= 0 ? "+" : ""}{formatUsd(pnlUsd)}</span>
      </div>
      <div className="position-cell">
        <span>Closed</span>
        <strong>{new Date(position.closedAt).toLocaleDateString()}</strong>
      </div>
      <div className="platform-stack">
        <span>{position.platform}</span>
        <strong>{position.exitPlatform}</strong>
      </div>
      <div className={`reason-pill ${position.closeReason}`}>{position.closeReason}</div>
    </article>
  );
}
