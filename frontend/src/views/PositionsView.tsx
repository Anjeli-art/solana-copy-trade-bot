import { useMemo, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import type { ClosedFilter, ClosedPosition, ManualRepeatToken, Position } from "../types";
import { CalendarInput } from "../components/CalendarInput";
import { ClosedPositionRow, PositionRow } from "../components/PositionRow";
import { TokenIcon } from "../components/TokenIcon";
import { toDateInputValue } from "../utils/format";
import { exportClosedPositions, filterClosedPositions } from "../utils/positions";

type PositionsViewProps = {
  positions: Position[];
  closedPositions?: ClosedPosition[];
  manualRepeatTokens?: ManualRepeatToken[];
  compact?: boolean;
  repeatBuyingMint?: string | null;
  onRepeatBuyToken?: (tokenMint: string) => void;
  onDeleteManualToken?: (tokenMint: string) => void;
  onSellPosition?: (id: string) => void;
};

export function PositionsView({
  positions,
  closedPositions = [],
  manualRepeatTokens = [],
  compact = false,
  repeatBuyingMint,
  onRepeatBuyToken,
  onDeleteManualToken,
  onSellPosition
}: PositionsViewProps) {
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>("week");
  const [customFrom, setCustomFrom] = useState(() => toDateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));
  const visiblePositions = compact ? positions.slice(0, 3) : positions;
  const hiddenPositionCount = compact ? Math.max(0, positions.length - visiblePositions.length) : 0;
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
                <h2>Manual positions</h2>
              </div>
            </div>
            <div className="repeat-token-list">
              {manualRepeatTokens.length === 0 ? (
                <div className="empty-state">No manual tokens</div>
              ) : (
                manualRepeatTokens.map((token) => (
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
                      {repeatBuyingMint === token.tokenMint ? "Buying" : "Buy"}
                    </button>
                    <button
                      className="manual-token-delete-button"
                      type="button"
                      aria-label="Delete manual token"
                      title="Delete manual token"
                      onClick={() => onDeleteManualToken?.(token.tokenMint)}
                    >
                      <Trash2 size={16} />
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
