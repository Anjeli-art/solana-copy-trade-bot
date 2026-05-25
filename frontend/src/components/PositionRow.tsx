import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, TrendingDown } from "lucide-react";
import type { ClosedPosition, Position } from "../types";
import { TokenIcon } from "./TokenIcon";
import { ConfirmModal } from "./ConfirmModal";
import { formatNumber, formatSol, formatUsd, shortAddress } from "../utils/format";
import { getClosedPnlUsd, getPnl } from "../utils/positions";
import { getAverageDownPreview } from "../api/client";
import type { AverageDownPreview } from "../api/client";

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
  const [sellPending, setSellPending] = useState(false);
  const [tierPending, setTierPending] = useState<"low" | "high" | null>(null);
  const [avgLoading, setAvgLoading] = useState(false);
  const [avgPreview, setAvgPreview] = useState<AverageDownPreview | null>(null);
  const [avgError, setAvgError] = useState<string | null>(null);
  const { pnlPercent, pnlUsd } = getPnl(position);

  async function openAverageDown() {
    setAvgLoading(true);
    setAvgError(null);
    try {
      const preview = await getAverageDownPreview(position.id);
      setAvgPreview(preview);
    } catch (error) {
      setAvgError(error instanceof Error ? error.message : "Failed to calculate");
    } finally {
      setAvgLoading(false);
    }
  }
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
    <>
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
          onClick={() => setTierPending(position.profitTier === "high" ? "low" : "high")}
        >
          {position.profitTier === "high" ? "High" : "Low"}
        </button>
        <button
          className="avg-button"
          type="button"
          title="Calculate average down"
          disabled={avgLoading}
          onClick={openAverageDown}
        >
          {avgLoading ? "…" : <TrendingDown size={14} />}
        </button>
        <button
          className="sell-button"
          type="button"
          onClick={() => setSellPending(true)}
        >
          Sell
        </button>
      </article>

      {sellPending && (
        <ConfirmModal
          title={`Sell ${tokenLabel}?`}
          description="Market sell via Jupiter. Cannot be undone."
          confirmLabel="Sell"
          variant="danger"
          onConfirm={() => {
            setSellPending(false);
            onSell?.(position.id);
          }}
          onCancel={() => setSellPending(false)}
        />
      )}

      {tierPending && (
        <ConfirmModal
          title={`Move to ${tierPending.toUpperCase()} tier?`}
          description={`${tokenLabel} will be monitored by the ${tierPending} profit watcher.`}
          confirmLabel="Move"
          onConfirm={() => {
            const target = tierPending;
            setTierPending(null);
            onMoveProfitTier?.(position.id, target);
          }}
          onCancel={() => setTierPending(null)}
        />
      )}

      {(avgPreview || avgError) && createPortal(
        <div className="modal-overlay" onClick={() => { setAvgPreview(null); setAvgError(null); }}>
          <div className="modal-card avg-preview-card" onClick={(e) => e.stopPropagation()}>
            <p className="modal-title">Average down — {tokenLabel}</p>
            {avgError ? (
              <p className="avg-preview-error">{avgError}</p>
            ) : avgPreview ? (
              <div className="avg-preview-rows">
                <div className="avg-preview-row">
                  <span>Current</span>
                  <strong className="negative">{(avgPreview.currentMultiplier * 100 - 100).toFixed(1)}%</strong>
                </div>
                <div className="avg-preview-row highlight">
                  <span>Buy</span>
                  <strong>{formatSol(avgPreview.dcaSol)} SOL</strong>
                </div>
                <div className="avg-preview-row">
                  <span>New avg entry</span>
                  <strong>{formatUsd(avgPreview.newAvgEntryUsd)}</strong>
                </div>
                <div className="avg-preview-divider" />
                <div className="avg-preview-row">
                  <span>Break-even at</span>
                  <strong>+{avgPreview.breakEvenRecoveryPct.toFixed(2)}% from here</strong>
                </div>
                <div className="avg-preview-row">
                  <span>Take-profit at</span>
                  <strong className="positive">+{avgPreview.takeProfitRecoveryPct.toFixed(2)}% from here</strong>
                </div>
              </div>
            ) : null}
            <div className="modal-actions">
              <button className="modal-cancel" type="button" onClick={() => { setAvgPreview(null); setAvgError(null); }}>
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export function ClosedPositionRow({ position, solPriceUsd = 0 }: { position: ClosedPosition; solPriceUsd?: number }) {
  const [copiedMint, setCopiedMint] = useState(false);
  const { pnlPercent, pnlUsd } = getClosedPnlUsd(position, solPriceUsd);
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
