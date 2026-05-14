import { Download, Plus, Trash2, Wallet } from "lucide-react";
import type { Trader, TraderFormHandler } from "../types";
import { shortAddress } from "../utils/format";
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
                <strong title={trader.address}>{shortAddress(trader.address)}</strong>
                <span>{new Date(trader.createdAt).toLocaleString()}</span>
              </div>
              <div className="trader-status">Ready</div>
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
