import { useMemo, useState } from "react";
import { Check, ChevronDown, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { BotLog } from "../types";
import { CalendarInput } from "../components/CalendarInput";
import { TimeInput } from "../components/TimeInput";
import { shortAddress } from "../utils/format";

type LogsViewProps = {
  logs: BotLog[];
  isRefreshing: boolean;
  onDeleteLog: (id: string) => void;
  onRefresh: () => void;
};

type LogStatusFilter = "all" | BotLog["level"];

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

export function LogsView({ logs, isRefreshing, onDeleteLog, onRefresh }: LogsViewProps) {
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(() => toDateInputValue(new Date()));
  const [toDate, setToDate] = useState(() => toDateInputValue(new Date()));
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [statusFilter, setStatusFilter] = useState<LogStatusFilter>("all");
  const filteredLogs = useMemo(() => {
    const from = getLogTimestamp(fromDate, fromTime);
    const to = getLogTimestamp(toDate, toTime, true);

    return logs.filter((log) => {
      if (statusFilter !== "all" && log.level !== statusFilter) return false;
      const createdAt = new Date(log.createdAt).getTime();
      if (from !== undefined && createdAt < from) return false;
      if (to !== undefined && createdAt > to) return false;
      return true;
    });
  }, [fromDate, fromTime, logs, statusFilter, toDate, toTime]);

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
          <label className="log-status-filter">
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as LogStatusFilter)}>
              <option value="all">All</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
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
          filteredLogs.map((log) => (
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
    </section>
  );
}
