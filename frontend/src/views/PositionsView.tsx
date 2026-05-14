import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { ClosedFilter, ClosedPosition, Position } from "../types";
import { CalendarInput } from "../components/CalendarInput";
import { ClosedPositionRow, PositionRow } from "../components/PositionRow";
import { toDateInputValue } from "../utils/format";
import { exportClosedPositions, filterClosedPositions } from "../utils/positions";

type PositionsViewProps = {
  positions: Position[];
  closedPositions?: ClosedPosition[];
  compact?: boolean;
  onSellPosition?: (id: string) => void;
};

export function PositionsView({ positions, closedPositions = [], compact = false, onSellPosition }: PositionsViewProps) {
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>("week");
  const [customFrom, setCustomFrom] = useState(() => toDateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));
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
            <h2>Open positions</h2>
          </div>
        </div>
        <div className="positions-list">
          {positions.length === 0 ? (
            <div className="empty-state">No open positions</div>
          ) : (
            positions.slice(0, compact ? 3 : positions.length).map((position) => (
              <PositionRow key={position.id} position={position} onSell={onSellPosition} />
            ))
          )}
        </div>
      </section>
      {!compact ? (
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
      ) : null}
    </>
  );
}
