import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { BotLog } from "../types";
import { CalendarInput } from "../components/CalendarInput";
import { TimeInput } from "../components/TimeInput";
import { shortAddress } from "../utils/format";

type LogsViewProps = {
  logs: BotLog[];
  eventOptions: string[];
  eventFilter: string;
  isRefreshing: boolean;
  onEventFilterChange: (event: string) => void;
  onDeleteLog: (id: string) => void;
  onRefresh: () => void;
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

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLogTimestamp(dateValue: string, timeValue: string, endOfDay = false) {
  if (!dateValue && !timeValue) {
    return undefined;
  }

  const date = dateValue || toDateInputValue(new Date());
  const time = timeValue || (endOfDay ? "23:59" : "00:00");
  return new Date(`${date}T${time}:00`).getTime();
}

function logDetailRows(log: BotLog) {
  return [
    { label: "Message", value: log.message },
    { label: "Trader", value: log.trader || "-", copyValue: log.trader },
    { label: "Token", value: log.tokenMint || "-", copyValue: log.tokenMint },
    { label: "Signature", value: log.signature || "-" },
    { label: "Position", value: log.positionId || "-" },
    { label: "Metadata", value: log.metadata ? JSON.stringify(log.metadata, null, 2) : "-" }
  ];
}

export function LogsView({
  logs,
  eventOptions,
  eventFilter,
  isRefreshing,
  onEventFilterChange,
  onDeleteLog,
  onRefresh
}: LogsViewProps) {
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(() => toDateInputValue(new Date()));
  const [toDate, setToDate] = useState(() => toDateInputValue(new Date()));
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [logsPageSize, setLogsPageSize] = useState(() => readStoredPageSize("logs.pageSize", 10));
  const [logsPage, setLogsPage] = useState(() => readStoredPage("logs.page"));
  const didMountLogsPagination = useRef(false);

  const filteredLogs = useMemo(() => {
    const from = getLogTimestamp(fromDate, fromTime);
    const to = getLogTimestamp(toDate, toTime, true);

    return logs.filter((log) => {
      const createdAt = new Date(log.createdAt).getTime();
      if (from !== undefined && createdAt < from) return false;
      if (to !== undefined && createdAt > to) return false;
      return true;
    });
  }, [fromDate, fromTime, logs, toDate, toTime]);

  const logsPageCount = Math.max(1, Math.ceil(filteredLogs.length / logsPageSize));
  const activeLogsPage = Math.min(logsPage, logsPageCount);
  const paginatedLogs = filteredLogs.slice(
    (activeLogsPage - 1) * logsPageSize,
    activeLogsPage * logsPageSize
  );

  useEffect(() => {
    storeNumber("logs.pageSize", logsPageSize);
  }, [logsPageSize]);

  useEffect(() => {
    storeNumber("logs.page", logsPage);
  }, [logsPage]);

  useEffect(() => {
    if (!didMountLogsPagination.current) {
      didMountLogsPagination.current = true;
      return;
    }
    setLogsPage(1);
    setExpandedLogId(null);
  }, [eventFilter, fromDate, fromTime, logsPageSize, toDate, toTime]);

  useEffect(() => {
    setLogsPage((page) => Math.min(Math.max(1, page), logsPageCount));
  }, [logsPageCount]);

  async function copyLogValue(fieldId: string, value?: string) {
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopiedField(fieldId);
    window.setTimeout(() => setCopiedField((current) => (current === fieldId ? null : current)), 1200);
  }

  return (
    <section className="positions-section logs-section">
      <div className="section-head logs-section-head">
        <div>
          <p className="eyebrow">Bot events</p>
          <h2>Logs</h2>
        </div>
        <div className="logs-actions">
          <CalendarInput label="From date" value={fromDate} onChange={setFromDate} />
          <TimeInput label="From time" value={fromTime} onChange={setFromTime} />
          <CalendarInput label="To date" value={toDate} onChange={setToDate} />
          <TimeInput label="To time" value={toTime} onChange={setToTime} />
          <label className="log-select-filter">
            <span>Event</span>
            <select value={eventFilter} onChange={(event) => onEventFilterChange(event.target.value)}>
              <option value="all">All events</option>
              {eventOptions.map((eventName) => (
                <option value={eventName} key={eventName}>
                  {eventName}
                </option>
              ))}
            </select>
          </label>
          <button
            className="refresh-button"
            type="button"
            aria-label="Refresh logs"
            disabled={isRefreshing}
            onClick={onRefresh}
          >
            <RefreshCw size={16} className={isRefreshing ? "spin" : ""} />
          </button>
        </div>
      </div>
      <div className="logs-table">
        <div className="logs-row logs-head">
          <span></span>
          <span>Time</span>
          <span>Level</span>
          <span>Event</span>
          <span>Wallet</span>
          <span>Token</span>
          <span>Message</span>
        </div>
        {filteredLogs.length === 0 ? (
          <div className="empty-state">No logs yet</div>
        ) : (
          paginatedLogs.map((log) => (
            <div className={`log-entry ${expandedLogId === log.id ? "expanded" : ""}`} key={log.id}>
              <button
                className="logs-row"
                type="button"
                aria-expanded={expandedLogId === log.id}
                onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
              >
                <ChevronDown size={16} className="log-expand-icon" />
                <span>{new Date(log.createdAt).toLocaleString()}</span>
                <strong className={`log-level ${log.level}`}>{log.level}</strong>
                <span title={log.event}>{log.event}</span>
                <span title={log.wallet || log.trader}>{log.wallet || log.trader ? shortAddress(log.wallet || log.trader || "") : "-"}</span>
                <span title={log.tokenMint}>{log.tokenMint ? shortAddress(log.tokenMint) : "-"}</span>
                <span title={log.message}>{log.message}</span>
              </button>
              {expandedLogId === log.id ? (
                <div className="log-details">
                  <div className="log-detail-actions">
                    <button
                      className="delete-log-button"
                      type="button"
                      onClick={() => onDeleteLog(log.id)}
                    >
                      <Trash2 size={14} />
                      Delete log
                    </button>
                  </div>
                  <div className="log-detail-grid">
                    {logDetailRows(log).map((row) => {
                      const fieldId = `${log.id}:${row.label}`;
                      return (
                      <div className="log-detail-row" key={row.label}>
                        <span>{row.label}</span>
                        <div className={`log-detail-value ${row.copyValue ? "copyable" : ""}`}>
                          <code>{row.value}</code>
                          {row.copyValue ? (
                            <button
                              className="copy-field-button"
                              type="button"
                              aria-label={`Copy ${row.label}`}
                              onClick={() => copyLogValue(fieldId, row.copyValue)}
                            >
                              {copiedField === fieldId ? <Check size={14} /> : <Copy size={14} />}
                              <span>{copiedField === fieldId ? "Copied" : "Copy"}</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
      {filteredLogs.length > 0 ? (
        <div className="table-pagination" aria-label="Logs pagination">
          <label className="select-wrap page-size-wrap pagination-page-size">
            <span>Rows</span>
            <select
              aria-label="Logs rows per page"
              value={logsPageSize}
              onChange={(event) => setLogsPageSize(Number(event.target.value))}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={50}>50</option>
            </select>
          </label>
          <span className="pagination-range">
            {(activeLogsPage - 1) * logsPageSize + 1}-
            {Math.min(activeLogsPage * logsPageSize, filteredLogs.length)} of{" "}
            {filteredLogs.length}
          </span>
          <div className="closed-page-buttons">
            <button
              type="button"
              aria-label="Previous logs page"
              disabled={activeLogsPage <= 1}
              onClick={() => setLogsPage((page) => Math.max(1, page - 1))}
            >
              <ChevronLeft size={16} />
            </button>
            <strong>{activeLogsPage} / {logsPageCount}</strong>
            <button
              type="button"
              aria-label="Next logs page"
              disabled={activeLogsPage >= logsPageCount}
              onClick={() => setLogsPage((page) => Math.min(logsPageCount, page + 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
