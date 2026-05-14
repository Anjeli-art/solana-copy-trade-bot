import { RefreshCw, Wallet } from "lucide-react";
import type { BotWallet } from "../types";
import { formatSol, formatUsd, shortAddress } from "../utils/format";

type BotWalletCardProps = {
  wallet: BotWallet;
  isRefreshing: boolean;
  onRefresh: () => void;
};

export function BotWalletCard({ wallet, isRefreshing, onRefresh }: BotWalletCardProps) {
  const usdValue = wallet.solBalance * wallet.solPriceUsd;

  return (
    <section className="wallet-balance-card">
      <div className="wallet-card-main">
        <div className="wallet-card-icon">
          <Wallet size={22} />
        </div>
        <div>
          <p className="eyebrow">Bot wallet</p>
          <h2>{shortAddress(wallet.address)}</h2>
        </div>
      </div>
      <div className="wallet-balance-grid">
        <div className="wallet-balance-item">
          <span>SOL balance</span>
          <strong>{formatSol(wallet.solBalance)} SOL</strong>
        </div>
        <div className="wallet-balance-item">
          <span>Estimated value</span>
          <strong>{wallet.solPriceUsd > 0 ? formatUsd(usdValue) : "-"}</strong>
          <small>{wallet.solPriceUsd > 0 ? `${formatUsd(wallet.solPriceUsd)} / SOL` : "SOL price unavailable"}</small>
        </div>
        <div className={`wallet-balance-item ${wallet.realizedPnlTodayUsd >= 0 ? "positive" : "negative"}`}>
          <span>Realized today</span>
          <strong>
            {wallet.realizedPnlTodayUsd >= 0 ? "+" : ""}
            {formatUsd(wallet.realizedPnlTodayUsd)}
          </strong>
        </div>
      </div>
      <div className="wallet-card-footer">
        <span>{new Date(wallet.lastUpdated).toLocaleTimeString()}</span>
        <button
          className="refresh-button"
          type="button"
          aria-label="Refresh wallet balance"
          disabled={isRefreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={16} className={isRefreshing ? "spin" : ""} />
        </button>
      </div>
    </section>
  );
}
