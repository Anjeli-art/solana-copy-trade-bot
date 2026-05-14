import { RefreshCw } from "lucide-react";
import type { BotLog } from "../types";
import { shortAddress } from "../utils/format";

type LogsViewProps = {
  logs: BotLog[];
  isRefreshing: boolean;
  onRefresh: () => void;
};

export function LogsView({ logs, isRefreshing, onRefresh }: LogsViewProps) {
  return (
    <section className="positions-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">Bot events</p>
          <h2>Logs</h2>
        </div>
        <button className="refresh-button" type="button" aria-label="Refresh logs" disabled={isRefreshing} onClick={onRefresh}>
          <RefreshCw size={16} className={isRefreshing ? "spin" : ""} />
        </button>
      </div>
      <div className="logs-table">
        <div className="logs-row logs-head">
          <span>Time</span>
          <span>Level</span>
          <span>Event</span>
          <span>Token</span>
          <span>Message</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty-state">No logs yet</div>
        ) : (
          logs.map((log) => (
            <div className="logs-row" key={log.id}>
              <span>{new Date(log.createdAt).toLocaleString()}</span>
              <strong className={`log-level ${log.level}`}>{log.level}</strong>
              <span>{log.event}</span>
              <span title={log.tokenMint}>{log.tokenMint ? shortAddress(log.tokenMint) : "-"}</span>
              <span title={log.message}>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
