import { Check, Copy, Download, Plus, Trash2, Wallet } from "lucide-react";
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
};

export function TradersView({
  traders,
  walletAddress,
  error,
  setWalletAddress,
  setError,
  addTrader,
  removeTrader
}: TradersViewProps) {
  const [copiedTrader, setCopiedTrader] = useState<string | null>(null);

  async function copyTraderAddress(address: string) {
    await navigator.clipboard.writeText(address);
    setCopiedTrader(address);
    window.setTimeout(() => setCopiedTrader((current) => (current === address ? null : current)), 1200);
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
      <div className="trader-list">
        {traders.length === 0 ? (
          <div className="empty-state">No tracked wallets</div>
        ) : (
          traders.map((trader) => (
            <article className="trader-row" key={trader.address}>
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
                className="icon-button"
                type="button"
                aria-label="Remove trader wallet"
                onClick={() => removeTrader(trader.address)}
              >
                <Trash2 size={17} />
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
