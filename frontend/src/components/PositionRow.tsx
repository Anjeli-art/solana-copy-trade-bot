import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ClosedPosition, Position } from "../types";
import { TokenIcon } from "./TokenIcon";
import { formatNumber, formatUsd, shortAddress } from "../utils/format";
import { getPnl } from "../utils/positions";

type PositionRowProps = {
  position: Position;
  onSell?: (id: string) => void;
};

function CopyMintButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button
      className="position-copy-button"
      type="button"
      aria-label="Copy token mint"
      title="Copy token mint"
      onClick={onCopy}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function PositionRow({ position, onSell }: PositionRowProps) {
  const [copiedMint, setCopiedMint] = useState(false);
  const { pnlPercent, pnlUsd } = getPnl(position);
  const tokenLabel = position.tokenName || position.tokenSymbol;
  const tokenDetails = position.tokenName
    ? `${position.tokenSymbol} • ${shortAddress(position.tokenMint)}`
    : shortAddress(position.tokenMint);

  async function copyMint() {
    await navigator.clipboard.writeText(position.tokenMint);
    setCopiedMint(true);
    window.setTimeout(() => setCopiedMint(false), 1200);
  }

  return (
    <article className="position-row">
      <TokenIcon mint={position.tokenMint} symbol={position.tokenSymbol} tokenImage={position.tokenImage} />
      <div className="position-token">
        <div className="position-token-text">
          <strong title={tokenLabel}>{tokenLabel}</strong>
          <span title={position.tokenMint}>{tokenDetails}</span>
        </div>
        <CopyMintButton copied={copiedMint} onCopy={copyMint} />
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
  const [copiedMint, setCopiedMint] = useState(false);
  const { pnlPercent, pnlUsd } = getPnl({
    ...position,
    currentPrice: position.exitPrice
  });
  const tokenLabel = position.tokenName || position.tokenSymbol;
  const tokenDetails = position.tokenName
    ? `${position.tokenSymbol} • ${shortAddress(position.tokenMint)}`
    : shortAddress(position.tokenMint);

  async function copyMint() {
    await navigator.clipboard.writeText(position.tokenMint);
    setCopiedMint(true);
    window.setTimeout(() => setCopiedMint(false), 1200);
  }

  return (
    <article className="position-row closed">
      <TokenIcon mint={position.tokenMint} symbol={position.tokenSymbol} tokenImage={position.tokenImage} />
      <div className="position-token">
        <div className="position-token-text">
          <strong title={tokenLabel}>{tokenLabel}</strong>
          <span title={position.tokenMint}>{tokenDetails}</span>
        </div>
        <CopyMintButton copied={copiedMint} onCopy={copyMint} />
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
