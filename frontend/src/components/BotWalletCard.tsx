import { Check, Copy, RefreshCw, Wallet } from "lucide-react";
import { useState } from "react";
import type { BotWallet } from "../types";
import { formatSol, formatUsd } from "../utils/format";

type BotWalletCardProps = {
  wallet: BotWallet;
  isRefreshing: boolean;
  onRefresh: () => void;
};

export function BotWalletCard({ wallet, isRefreshing, onRefresh }: BotWalletCardProps) {
  const [copiedWallet, setCopiedWallet] = useState(false);
  const usdValue = wallet.solBalance * wallet.solPriceUsd;

  async function copyWalletAddress() {
    if (!wallet.address) {
      return;
    }

    await navigator.clipboard.writeText(wallet.address);
    setCopiedWallet(true);
    window.setTimeout(() => setCopiedWallet(false), 1200);
  }

  return (
    <section className="wallet-balance-card">
      <div className="wallet-card-main">
        <div className="wallet-card-icon">
          <Wallet size={22} />
        </div>
        <div className="wallet-card-title">
          <p className="eyebrow">Bot wallet</p>
          <div className="wallet-address-line">
            <h2 title={wallet.address}>{wallet.address || "-"}</h2>
            <button
              className="wallet-copy-button"
              type="button"
              aria-label="Copy bot wallet"
              title="Copy bot wallet"
              disabled={!wallet.address}
              onClick={copyWalletAddress}
            >
              {copiedWallet ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
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
