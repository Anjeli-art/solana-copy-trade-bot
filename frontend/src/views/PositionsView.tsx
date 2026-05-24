import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Ban, ChevronLeft, ChevronRight, Download, Plus, Trash2 } from "lucide-react";
import type { BlacklistedToken, ClosedFilter, ClosedPosition, ManualRepeatToken, Position } from "../types";
import { CalendarInput } from "../components/CalendarInput";
import { ClosedPositionRow, PositionRow } from "../components/PositionRow";
import { TokenIcon } from "../components/TokenIcon";
import { toDateInputValue } from "../utils/format";
import { exportClosedPositions, filterClosedPositions } from "../utils/positions";

type PositionsViewProps = {
  positions: Position[];
  closedPositions?: ClosedPosition[];
  manualRepeatTokens?: ManualRepeatToken[];
  blacklistedTokens?: BlacklistedToken[];
  compact?: boolean;
  repeatBuyingMint?: string | null;
  onRepeatBuyToken?: (tokenMint: string) => void;
  onDeleteManualToken?: (tokenMint: string) => void;
  onAddBlacklistedToken?: (tokenMint: string, reason?: string) => Promise<void> | void;
  onDeleteBlacklistedToken?: (tokenMint: string) => void;
  onSellPosition?: (id: string) => void;
  onMoveProfitTier?: (id: string, profitTier: "low" | "high") => void;
};

const PAGE_SIZE_OPTIONS = [5, 10, 50];

function readStoredPageSize(key: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  const value = Number(window.localStorage.getItem(key));
  return PAGE_SIZE_OPTIONS.includes(value) ? value : fallback;
}

function readStoredPage(key: string) {
  if (typeof window === "undefined") return 1;
  const value = Number(window.localStorage.getItem(key));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function storeNumber(key: string, value: number) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(key, String(value));
  }
}

export function PositionsView({
  positions,
  closedPositions = [],
  manualRepeatTokens = [],
  blacklistedTokens = [],
  compact = false,
  repeatBuyingMint,
  onRepeatBuyToken,
  onDeleteManualToken,
  onAddBlacklistedToken,
  onDeleteBlacklistedToken,
  onSellPosition,
  onMoveProfitTier
}: PositionsViewProps) {
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>("week");
  const [customFrom, setCustomFrom] = useState(() => toDateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));
  const [blacklistMint, setBlacklistMint] = useState("");
  const [blacklistReason, setBlacklistReason] = useState("");
  const [isAddingBlacklistToken, setIsAddingBlacklistToken] = useState(false);
  const [blacklistPageSize, setBlacklistPageSize] = useState(() => readStoredPageSize("positions.blacklistPageSize", 10));
  const [blacklistPage, setBlacklistPage] = useState(() => readStoredPage("positions.blacklistPage"));
  const [manualPageSize, setManualPageSize] = useState(() => readStoredPageSize("positions.manualPageSize", 10));
  const [manualPage, setManualPage] = useState(() => readStoredPage("positions.manualPage"));
  const [closedPageSize, setClosedPageSize] = useState(() => readStoredPageSize("positions.closedPageSize", 10));
  const [closedPage, setClosedPage] = useState(() => readStoredPage("positions.closedPage"));
  const didMountBlacklistPageSize = useRef(false);
  const didMountManualPageSize = useRef(false);
  const didMountClosedPagination = useRef(false);
  const orderedPositions = useMemo(
    () => [
      ...positions.filter((position) => position.profitTier === "high"),
      ...positions.filter((position) => position.profitTier === "low")
    ],
    [positions]
  );
  const visiblePositions = compact ? orderedPositions.slice(0, 3) : orderedPositions;
  const hiddenPositionCount = compact ? Math.max(0, positions.length - visiblePositions.length) : 0;
  const blacklistPageCount = Math.max(1, Math.ceil(blacklistedTokens.length / blacklistPageSize));
  const activeBlacklistPage = Math.min(blacklistPage, blacklistPageCount);
  const paginatedBlacklistedTokens = blacklistedTokens.slice(
    (activeBlacklistPage - 1) * blacklistPageSize,
    activeBlacklistPage * blacklistPageSize
  );
  const manualPageCount = Math.max(1, Math.ceil(manualRepeatTokens.length / manualPageSize));
  const activeManualPage = Math.min(manualPage, manualPageCount);
  const paginatedManualRepeatTokens = manualRepeatTokens.slice(
    (activeManualPage - 1) * manualPageSize,
    activeManualPage * manualPageSize
  );
  const filteredClosedPositions = useMemo(
    () => filterClosedPositions(closedPositions, closedFilter, customFrom, customTo),
    [closedFilter, closedPositions, customFrom, customTo]
  );
  const closedPageCount = Math.max(1, Math.ceil(filteredClosedPositions.length / closedPageSize));
  const activeClosedPage = Math.min(closedPage, closedPageCount);
  const paginatedClosedPositions = filteredClosedPositions.slice(
    (activeClosedPage - 1) * closedPageSize,
    activeClosedPage * closedPageSize
  );
  const normalizedBlacklistMint = blacklistMint.trim();

  useEffect(() => {
    storeNumber("positions.blacklistPageSize", blacklistPageSize);
  }, [blacklistPageSize]);

  useEffect(() => {
    storeNumber("positions.blacklistPage", blacklistPage);
  }, [blacklistPage]);

  useEffect(() => {
    storeNumber("positions.manualPageSize", manualPageSize);
  }, [manualPageSize]);

  useEffect(() => {
    storeNumber("positions.manualPage", manualPage);
  }, [manualPage]);

  useEffect(() => {
    storeNumber("positions.closedPageSize", closedPageSize);
  }, [closedPageSize]);

  useEffect(() => {
    storeNumber("positions.closedPage", closedPage);
  }, [closedPage]);

  useEffect(() => {
    if (!didMountClosedPagination.current) {
      didMountClosedPagination.current = true;
      return;
    }
    setClosedPage(1);
  }, [closedFilter, customFrom, customTo, closedPageSize]);

  useEffect(() => {
    setClosedPage((page) => Math.min(Math.max(1, page), closedPageCount));
  }, [closedPageCount]);

  useEffect(() => {
    if (!didMountBlacklistPageSize.current) {
      didMountBlacklistPageSize.current = true;
      return;
    }
    setBlacklistPage(1);
  }, [blacklistPageSize]);

  useEffect(() => {
    setBlacklistPage((page) => Math.min(Math.max(1, page), blacklistPageCount));
  }, [blacklistPageCount]);

  useEffect(() => {
    if (!didMountManualPageSize.current) {
      didMountManualPageSize.current = true;
      return;
    }
    setManualPage(1);
  }, [manualPageSize]);

  useEffect(() => {
    setManualPage((page) => Math.min(Math.max(1, page), manualPageCount));
  }, [manualPageCount]);

  function renderPositionGroup(tier: "high" | "low", label: string) {
    const groupedPositions = visiblePositions.filter((position) => position.profitTier === tier);

    if (groupedPositions.length === 0) {
      return null;
    }

    return (
      <div className="position-tier-group">
        <div className={`position-tier-heading ${tier}`}>
          <span>{label}</span>
          <strong>{groupedPositions.length}</strong>
        </div>
        {groupedPositions.map((position) => (
          <PositionRow
            key={position.id}
            position={position}
            onSell={onSellPosition}
            onMoveProfitTier={onMoveProfitTier}
          />
        ))}
      </div>
    );
  }

  async function submitBlacklistToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedBlacklistMint || !onAddBlacklistedToken) {
      return;
    }

    setIsAddingBlacklistToken(true);
    try {
      await onAddBlacklistedToken(normalizedBlacklistMint, blacklistReason);
      setBlacklistMint("");
      setBlacklistReason("");
    } finally {
      setIsAddingBlacklistToken(false);
    }
  }

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
            <>
              {renderPositionGroup("high", "High profit")}
              {renderPositionGroup("low", "Low profit")}
            </>
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
                <p className="eyebrow">Copy exclusions</p>
                <h2>Token blacklist</h2>
              </div>
            </div>
            <form className="blacklist-form" onSubmit={submitBlacklistToken}>
              <label className="blacklist-input">
                <span>Mint</span>
                <input
                  value={blacklistMint}
                  onChange={(event) => setBlacklistMint(event.target.value)}
                  placeholder="Token mint"
                  autoComplete="off"
                />
              </label>
              <label className="blacklist-input blacklist-reason-input">
                <span>Reason</span>
                <input
                  value={blacklistReason}
                  onChange={(event) => setBlacklistReason(event.target.value)}
                  placeholder="Optional"
                  autoComplete="off"
                />
              </label>
              <button
                className="blacklist-add-button"
                type="submit"
                disabled={!normalizedBlacklistMint || !onAddBlacklistedToken || isAddingBlacklistToken}
              >
                <Plus size={16} />
                {isAddingBlacklistToken ? "Adding" : "Add"}
              </button>
            </form>
            <div className="repeat-token-list">
              {blacklistedTokens.length === 0 ? (
                <div className="empty-state">No blacklisted tokens</div>
              ) : (
                paginatedBlacklistedTokens.map((token) => (
                  <article className="blacklist-token-row" key={token.tokenMint}>
                    <div className="repeat-token-asset">
                      <TokenIcon mint={token.tokenMint} symbol={token.tokenSymbol || token.tokenMint.slice(0, 4)} tokenImage={token.tokenImage} />
                      <div className="repeat-token-main">
                        <strong title={token.tokenName || token.tokenSymbol || token.tokenMint}>
                          {token.tokenName || token.tokenSymbol || token.tokenMint}
                        </strong>
                        <span title={token.tokenMint}>{token.tokenSymbol || "TOKEN"} • {token.tokenMint}</span>
                      </div>
                    </div>
                    <div className="blacklist-reason" title={token.reason || "Copy buys blocked"}>
                      <Ban size={14} />
                      <span>{token.reason || "Copy buys blocked"}</span>
                    </div>
                    <button
                      className="manual-token-delete-button"
                      type="button"
                      aria-label="Delete blacklisted token"
                      title="Delete blacklisted token"
                      onClick={() => onDeleteBlacklistedToken?.(token.tokenMint)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                ))
              )}
            </div>
            {blacklistedTokens.length > 0 ? (
              <div className="table-pagination" aria-label="Blacklisted tokens pagination">
                <label className="select-wrap page-size-wrap pagination-page-size">
                  <span>Rows</span>
                  <select
                    aria-label="Blacklisted tokens rows per page"
                    value={blacklistPageSize}
                    onChange={(event) => setBlacklistPageSize(Number(event.target.value))}
                  >
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <span className="pagination-range">
                  {(activeBlacklistPage - 1) * blacklistPageSize + 1}-
                  {Math.min(activeBlacklistPage * blacklistPageSize, blacklistedTokens.length)} of{" "}
                  {blacklistedTokens.length}
                </span>
                <div className="closed-page-buttons">
                  <button
                    type="button"
                    aria-label="Previous blacklisted tokens page"
                    disabled={activeBlacklistPage <= 1}
                    onClick={() => setBlacklistPage((page) => Math.max(1, page - 1))}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <strong>{activeBlacklistPage} / {blacklistPageCount}</strong>
                  <button
                    type="button"
                    aria-label="Next blacklisted tokens page"
                    disabled={activeBlacklistPage >= blacklistPageCount}
                    onClick={() => setBlacklistPage((page) => Math.min(blacklistPageCount, page + 1))}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            ) : null}
          </section>
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
                paginatedManualRepeatTokens.map((token) => (
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
            {manualRepeatTokens.length > 0 ? (
              <div className="table-pagination" aria-label="Manual positions pagination">
                <label className="select-wrap page-size-wrap pagination-page-size">
                  <span>Rows</span>
                  <select
                    aria-label="Manual positions rows per page"
                    value={manualPageSize}
                    onChange={(event) => setManualPageSize(Number(event.target.value))}
                  >
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <span className="pagination-range">
                  {(activeManualPage - 1) * manualPageSize + 1}-
                  {Math.min(activeManualPage * manualPageSize, manualRepeatTokens.length)} of{" "}
                  {manualRepeatTokens.length}
                </span>
                <div className="closed-page-buttons">
                  <button
                    type="button"
                    aria-label="Previous manual positions page"
                    disabled={activeManualPage <= 1}
                    onClick={() => setManualPage((page) => Math.max(1, page - 1))}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <strong>{activeManualPage} / {manualPageCount}</strong>
                  <button
                    type="button"
                    aria-label="Next manual positions page"
                    disabled={activeManualPage >= manualPageCount}
                    onClick={() => setManualPage((page) => Math.min(manualPageCount, page + 1))}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            ) : null}
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
                paginatedClosedPositions.map((position) => (
                  <ClosedPositionRow key={position.id} position={position} />
                ))
              )}
            </div>
            {filteredClosedPositions.length > 0 ? (
              <div className="table-pagination" aria-label="Closed positions pagination">
                <label className="select-wrap page-size-wrap pagination-page-size">
                  <span>Rows</span>
                  <select
                    aria-label="Closed positions rows per page"
                    value={closedPageSize}
                    onChange={(event) => setClosedPageSize(Number(event.target.value))}
                  >
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <span className="pagination-range">
                  {(activeClosedPage - 1) * closedPageSize + 1}-
                  {Math.min(activeClosedPage * closedPageSize, filteredClosedPositions.length)} of{" "}
                  {filteredClosedPositions.length}
                </span>
                <div className="closed-page-buttons">
                  <button
                    type="button"
                    aria-label="Previous closed positions page"
                    disabled={activeClosedPage <= 1}
                    onClick={() => setClosedPage((page) => Math.max(1, page - 1))}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <strong>{activeClosedPage} / {closedPageCount}</strong>
                  <button
                    type="button"
                    aria-label="Next closed positions page"
                    disabled={activeClosedPage >= closedPageCount}
                    onClick={() => setClosedPage((page) => Math.min(closedPageCount, page + 1))}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}
