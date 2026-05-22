type TopbarProps = {
  copyEnabled: boolean;
  profitEnabled: boolean;
  updatingMode: "copy" | "profit" | null;
  onToggleCopy: () => void;
  onToggleProfit: () => void;
};

export function Topbar({ copyEnabled, profitEnabled, updatingMode, onToggleCopy, onToggleProfit }: TopbarProps) {
  const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:3001";

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Local bot console</p>
        <h1>Solana copy trading</h1>
      </div>
      <div className="topbar-actions">
        <div className="status">Backend: {apiUrl.replace(/^https?:\/\//, "")}</div>
        <button
          className={`trading-toggle ${copyEnabled ? "running" : ""}`}
          type="button"
          disabled={updatingMode === "copy"}
          onClick={onToggleCopy}
        >
          {copyEnabled ? "Stop buy" : "Start buy"}
        </button>
        <button
          className={`trading-toggle sell-toggle ${profitEnabled ? "running" : ""}`}
          type="button"
          disabled={updatingMode === "profit"}
          onClick={onToggleProfit}
        >
          {profitEnabled ? "Stop sell" : "Start sell"}
        </button>
      </div>
    </header>
  );
}
