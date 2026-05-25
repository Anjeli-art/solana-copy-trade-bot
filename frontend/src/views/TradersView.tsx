import { Check, Copy, Download, Pause, Play, Plus, Trash2, Wallet } from "lucide-react";
import { useState } from "react";
import type { Trader, TraderFormHandler } from "../types";
import { exportTraders } from "../utils/traders";

type TradersViewProps = {
  traders: Trader[];
  walletAddress: string;
  error: string;
  setWalletAddress: (value: string) => void;
  setError: (value: string) => void;
  addTrader: TraderFormHandler;
  removeTrader: (address: string) => void;
  toggleTrader: (address: string, enabled: boolean) => void;
};

export function TradersView({
  traders,
  walletAddress,
  error,
  setWalletAddress,
  setError,
  addTrader,
  removeTrader,
  toggleTrader
}: TradersViewProps) {
  const [copiedTrader, setCopiedTrader] = useState<string | null>(null);

  const activeTraders = traders.filter((t) => t.enabled !== false);
  const pausedTraders = traders.filter((t) => t.enabled === false);

  async function copyTraderAddress(address: string) {
    await navigator.clipboard.writeText(address);
    setCopiedTrader(address);
    window.setTimeout(() => setCopiedTrader((current) => (current === address ? null : current)), 1200);
  }

  function renderTraderRow(trader: Trader, paused: boolean) {
    return (
      <article className={`trader-row${paused ? " paused" : ""}`} key={trader.address}>
        <div className="wallet-icon">
          <Wallet size={18} />
        </div>
        <div className="trader-meta">
          <div className="trader-address-line">
            <strong title={trader.address}>{trader.address}</strong>
            <button
              className="trader-copy-button"
              type="button"
              aria-label="Copy trader wallet"
              title="Copy trader wallet"
              onClick={() => copyTraderAddress(trader.address)}
            >
              {copiedTrader === trader.address ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <span>{new Date(trader.createdAt).toLocaleString()}</span>
        </div>
        <button
          className={`icon-button trader-toggle-button${paused ? " resume" : " pause"}`}
          type="button"
          aria-label={paused ? "Resume tracking" : "Pause tracking"}
          title={paused ? "Resume tracking" : "Pause tracking"}
          onClick={() => toggleTrader(trader.address, paused)}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Remove trader wallet"
          onClick={() => removeTrader(trader.address)}
        >
          <Trash2 size={17} />
        </button>
      </article>
    );
  }

  return (
    <section className="trader-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">Manual tracking</p>
          <h2>Trader wallets</h2>
        </div>
        <button className="export-button" type="button" onClick={() => exportTraders(traders)}>
          <Download size={17} />
          Export
        </button>
      </div>
      <form className="wallet-form" onSubmit={addTrader}>
        <label className="input-wrap">
          <span>Wallet address</span>
          <input
            value={walletAddress}
            onChange={(event) => {
              setWalletAddress(event.target.value);
              setError("");
            }}
            placeholder="Paste Solana wallet address"
          />
        </label>
        <button className="primary-button" type="submit" aria-label="Add trader wallet">
          <Plus size={18} />
          Add
        </button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}

      <div className="trader-group-label">
        Active
        <span className="trader-group-count">{activeTraders.length}</span>
      </div>
      <div className="trader-list">
        {activeTraders.length === 0 ? (
          <div className="empty-state">No active traders</div>
        ) : (
          activeTraders.map((trader) => renderTraderRow(trader, false))
        )}
      </div>

      {pausedTraders.length > 0 && (
        <>
          <div className="trader-group-label paused">
            Paused
            <span className="trader-group-count">{pausedTraders.length}</span>
          </div>
          <div className="trader-list">
            {pausedTraders.map((trader) => renderTraderRow(trader, true))}
          </div>
        </>
      )}
    </section>
  );
}
