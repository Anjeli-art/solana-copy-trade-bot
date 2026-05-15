import { useEffect, useState } from "react";
import { CircleDollarSign } from "lucide-react";
import { getTokenMetadata } from "../api/client";
import type { ClosedPosition, Position } from "../types";
import { formatNumber, formatUsd, shortAddress } from "../utils/format";
import { getPnl } from "../utils/positions";

type PositionRowProps = {
  position: Position;
  onSell?: (id: string) => void;
};

const tokenImageCache = new Map<string, string | null>();

function TokenIcon({ mint, symbol, tokenImage }: { mint: string; symbol: string; tokenImage?: string }) {
  const [image, setImage] = useState(() => tokenImage || tokenImageCache.get(mint));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    if (tokenImage) {
      tokenImageCache.set(mint, tokenImage);
      setImage(tokenImage);
      return;
    }

    if (tokenImageCache.has(mint)) {
      setImage(tokenImageCache.get(mint));
      return;
    }

    setImage(undefined);
    getTokenMetadata(mint)
      .then((metadata) => {
        const nextImage = metadata.image || null;
        tokenImageCache.set(mint, nextImage);
        if (!cancelled) setImage(nextImage);
      })
      .catch(() => {
        tokenImageCache.set(mint, null);
        if (!cancelled) setImage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [mint, tokenImage]);

  if (image && !failed) {
    return (
      <div className="token-icon has-image">
        <img src={image} alt={symbol} loading="lazy" onError={() => setFailed(true)} />
      </div>
    );
  }

  return (
    <div className="token-icon">
      <CircleDollarSign size={18} />
    </div>
  );
}

export function PositionRow({ position, onSell }: PositionRowProps) {
  const { pnlPercent, pnlUsd } = getPnl(position);
  const tokenLabel = position.tokenName || position.tokenSymbol;
  const tokenDetails = position.tokenName
    ? `${position.tokenSymbol} • ${shortAddress(position.tokenMint)}`
    : shortAddress(position.tokenMint);

  return (
    <article className="position-row">
      <TokenIcon mint={position.tokenMint} symbol={position.tokenSymbol} tokenImage={position.tokenImage} />
      <div className="position-token">
        <strong title={tokenLabel}>{tokenLabel}</strong>
        <span title={position.tokenMint}>{tokenDetails}</span>
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
  const tokenLabel = position.tokenName || position.tokenSymbol;
  const tokenDetails = position.tokenName
    ? `${position.tokenSymbol} • ${shortAddress(position.tokenMint)}`
    : shortAddress(position.tokenMint);

  return (
    <article className="position-row closed">
      <TokenIcon mint={position.tokenMint} symbol={position.tokenSymbol} tokenImage={position.tokenImage} />
      <div className="position-token">
        <strong title={tokenLabel}>{tokenLabel}</strong>
        <span title={position.tokenMint}>{tokenDetails}</span>
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
