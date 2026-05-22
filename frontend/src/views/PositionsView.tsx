import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { ClosedFilter, ClosedPosition, Position } from "../types";
import { CalendarInput } from "../components/CalendarInput";
import { ClosedPositionRow, PositionRow } from "../components/PositionRow";
import { TokenIcon } from "../components/TokenIcon";
import { toDateInputValue } from "../utils/format";
import { exportClosedPositions, filterClosedPositions } from "../utils/positions";

type PositionsViewProps = {
  positions: Position[];
  closedPositions?: ClosedPosition[];
  compact?: boolean;
  buyAmountSol?: number;
  repeatBuyingMint?: string | null;
  onRepeatBuyToken?: (tokenMint: string) => void;
  onSellPosition?: (id: string) => void;
};

type KnownToken = {
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenImage?: string;
  platform: string;
};

export function PositionsView({
  positions,
  closedPositions = [],
  compact = false,
  buyAmountSol,
  repeatBuyingMint,
  onRepeatBuyToken,
  onSellPosition
}: PositionsViewProps) {
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>("week");
  const [customFrom, setCustomFrom] = useState(() => toDateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));
  const visiblePositions = compact ? positions.slice(0, 3) : positions;
  const hiddenPositionCount = compact ? Math.max(0, positions.length - visiblePositions.length) : 0;
  const knownTokens = useMemo(() => {
    const byMint = new Map<string, KnownToken>();
    for (const position of [...positions, ...closedPositions]) {
      if (!byMint.has(position.tokenMint)) {
        byMint.set(position.tokenMint, {
          tokenMint: position.tokenMint,
          tokenSymbol: position.tokenSymbol,
          tokenName: position.tokenName,
          tokenImage: position.tokenImage,
          platform: position.platform
        });
      }
    }
    return [...byMint.values()];
  }, [closedPositions, positions]);
  const filteredClosedPositions = useMemo(
    () => filterClosedPositions(closedPositions, closedFilter, customFrom, customTo),
    [closedFilter, closedPositions, customFrom, customTo]
  );

  return (
    <>
      <section className="positions-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Live positions</p>
            <h2>
              Open positions
              {compact && positions.length > 0 ? <span>{visiblePositions.length} of {positions.length}</span> : null}
            </h2>
          </div>
        </div>
        <div className="positions-list">
          {positions.length === 0 ? (
            <div className="empty-state">No open positions</div>
          ) : (
            visiblePositions.map((position) => (
              <PositionRow key={position.id} position={position} onSell={onSellPosition} />
            ))
          )}
          {hiddenPositionCount > 0 ? (
            <div className="compact-more-row">+{hiddenPositionCount} more open positions in Positions</div>
          ) : null}
        </div>
      </section>
      {!compact ? (
        <>
          <section className="positions-section">
            <div className="section-head">
              <div>
                <p className="eyebrow">Manual repeat buy</p>
                <h2>Known tokens</h2>
              </div>
            </div>
            <div className="repeat-token-list">
              {knownTokens.length === 0 ? (
                <div className="empty-state">No known tokens</div>
              ) : (
                knownTokens.map((token) => (
	                  <article className="repeat-token-row" key={token.tokenMint}>
	                    <div className="repeat-token-asset">
	                      <TokenIcon mint={token.tokenMint} symbol={token.tokenSymbol} tokenImage={token.tokenImage} />
	                      <div className="repeat-token-main">
	                        <strong title={token.tokenName || token.tokenSymbol}>{token.tokenName || token.tokenSymbol}</strong>
	                        <span title={token.tokenMint}>{token.tokenSymbol} • {token.tokenMint}</span>
	                      </div>
	                    </div>
                    <div className="platform-pill">{token.platform}</div>
                    <button
                      className="repeat-buy-button"
                      type="button"
                      disabled={!onRepeatBuyToken || repeatBuyingMint === token.tokenMint}
                      onClick={() => onRepeatBuyToken?.(token.tokenMint)}
                    >
                      {repeatBuyingMint === token.tokenMint ? "Buying" : `Buy ${buyAmountSol ?? ""} SOL`}
                    </button>
                  </article>
                ))
              )}
            </div>
          </section>
          <section className="positions-section">
            <div className="section-head">
              <div>
                <p className="eyebrow">Trade history</p>
                <h2>Closed positions</h2>
              </div>
              <div className="closed-actions">
                <label className="select-wrap">
                  <span>Period</span>
                  <select
                    aria-label="Closed positions period"
                    value={closedFilter}
                    onChange={(event) => setClosedFilter(event.target.value as ClosedFilter)}
                  >
                    <option value="today">Today</option>
                    <option value="week">Last week</option>
                    <option value="month">Last month</option>
                    <option value="custom">Custom</option>
                    <option value="all">All time</option>
                  </select>
                </label>
                {closedFilter === "custom" ? (
                  <div className="date-range">
                    <CalendarInput label="From" value={customFrom} onChange={setCustomFrom} allowClear={false} />
                    <CalendarInput label="To" value={customTo} onChange={setCustomTo} allowClear={false} />
                  </div>
                ) : null}
                <button
                  className="export-button"
                  type="button"
                  onClick={() => exportClosedPositions(filteredClosedPositions)}
                >
                  <Download size={17} />
                  Export
                </button>
              </div>
            </div>
            <div className="positions-list">
              {filteredClosedPositions.length === 0 ? (
                <div className="empty-state">No closed positions</div>
              ) : (
                filteredClosedPositions.map((position) => (
                  <ClosedPositionRow key={position.id} position={position} />
                ))
              )}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
