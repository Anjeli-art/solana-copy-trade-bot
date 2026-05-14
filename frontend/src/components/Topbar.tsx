type TopbarProps = {
  tradingEnabled: boolean;
  isTradingUpdating: boolean;
  onToggleTrading: () => void;
};

export function Topbar({ tradingEnabled, isTradingUpdating, onToggleTrading }: TopbarProps) {
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
          className={`trading-toggle ${tradingEnabled ? "running" : ""}`}
          type="button"
          disabled={isTradingUpdating}
          onClick={onToggleTrading}
        >
          {tradingEnabled ? "Stop trading" : "Start trading"}
        </button>
      </div>
    </header>
  );
}
