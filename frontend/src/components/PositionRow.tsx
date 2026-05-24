import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ClosedPosition, Position } from "../types";
import { TokenIcon } from "./TokenIcon";
import { formatNumber, formatSol, formatUsd, shortAddress } from "../utils/format";
import { getPnl } from "../utils/positions";

type PositionRowProps = {
  position: Position;
  onSell?: (id: string) => void;
  onMoveProfitTier?: (id: string, profitTier: "low" | "high") => void;
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

function formatPriceUpdatedAt(value?: string) {
  if (!value) {
    return "not updated";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "not updated";
  }

  return date.toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function PositionRow({ position, onSell, onMoveProfitTier }: PositionRowProps) {
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
    <article className="position-row active">
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
        <span title={position.priceUpdatedAt ? `Updated ${new Date(position.priceUpdatedAt).toLocaleString()}` : undefined}>
          Current · {formatPriceUpdatedAt(position.priceUpdatedAt)}
        </span>
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
      <button
        className={`tier-switch-button ${position.profitTier}`}
        type="button"
        title={position.profitTier === "high" ? "Move to low profit worker" : "Move to high profit worker"}
        onClick={() => onMoveProfitTier?.(position.id, position.profitTier === "high" ? "low" : "high")}
      >
        {position.profitTier === "high" ? "High" : "Low"}
      </button>
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
  const estimatedOutputSol =
    position.solSpent && position.entryPrice > 0 ? position.solSpent * (position.exitPrice / position.entryPrice) : undefined;
  const actualOutputSol =
    position.sellActualSolChange !== undefined && position.sellActualSolChange > 0
      ? position.sellActualSolChange
      : undefined;
  const outputSol = actualOutputSol ?? position.sellQuotedOutSol ?? position.sellActualSolChange ?? estimatedOutputSol;
  const solPnl = outputSol !== undefined && position.solSpent !== undefined ? outputSol - position.solSpent : undefined;
  const feeSol = position.sellNetworkFeeSol;
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
      <div className={`position-cell sol-result ${solPnl === undefined || solPnl >= 0 ? "positive" : "negative"}`}>
        <span>Net SOL</span>
        <strong title={solPnl === undefined ? undefined : `${solPnl >= 0 ? "+" : ""}${formatSol(solPnl)} SOL`}>
          {solPnl === undefined ? "-" : `${solPnl >= 0 ? "+" : ""}${formatSol(solPnl)}`}
        </strong>
        <small
          title={[
            outputSol !== undefined ? `${formatSol(outputSol)} SOL out` : undefined,
            feeSol !== undefined ? `${formatSol(feeSol)} SOL fee` : undefined,
            position.sellPriorityFeeSol !== undefined ? `${formatSol(position.sellPriorityFeeSol)} SOL priority` : undefined
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {outputSol !== undefined ? `${formatSol(outputSol)} out` : ""}
          {feeSol !== undefined ? ` · fee ${formatSol(feeSol)}` : ""}
        </small>
      </div>
      <div className="close-meta">
        <div className="platform-stack">
          <span>{position.platform}</span>
          <strong>{position.exitPlatform}</strong>
        </div>
        <div className={`reason-pill ${position.closeReason}`}>{position.closeReason}</div>
      </div>
    </article>
  );
}
