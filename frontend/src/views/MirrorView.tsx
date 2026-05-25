import { useState } from "react";
import { Check, Copy, ExternalLink, Pause, Play, Plus, Radio, Trash2 } from "lucide-react";
import { ConfirmModal } from "../components/ConfirmModal";
import { TokenIcon } from "../components/TokenIcon";
import type { MirrorClosedPosition, MirrorPosition, MirrorStatus, MirrorTrader } from "../types";
import { formatDistanceToNow, formatNumber, formatSol, formatUsd } from "../utils/format";

type MirrorViewProps = {
  status: MirrorStatus;
  traders: MirrorTrader[];
  positions: MirrorPosition[];
  closedPositions: MirrorClosedPosition[];
  updatingMirror: boolean;
  sellPending: string | null;
  solPriceUsd?: number;
  onToggleMirror: () => void;
  onAddTrader: (address: string, label: string, buyAmountSol: number) => Promise<boolean>;
  onRemoveTrader: (address: string) => void;
  onUpdateTrader: (address: string, patch: { label?: string; enabled?: boolean; buyAmountSol?: number }) => void;
  onSellPosition: (id: string) => void;
};

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
}

function solscanAddr(addr: string) {
  return `https://solscan.io/account/${addr}`;
}

function solscanTx(sig: string) {
  return `https://solscan.io/tx/${sig}`;
}

export function MirrorView({
  status,
  traders,
  positions,
  closedPositions,
  updatingMirror,
  sellPending,
  solPriceUsd = 0,
  onToggleMirror,
  onAddTrader,
  onRemoveTrader,
  onUpdateTrader,
  onSellPosition
}: MirrorViewProps) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [buyAmount, setBuyAmount] = useState("0.1");
  const [addError, setAddError] = useState("");
  const [addPending, setAddPending] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [sellConfirm, setSellConfirm] = useState<MirrorPosition | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<MirrorTrader | null>(null);

  const activeTraders = traders.filter((t) => t.enabled);
  const pausedTraders = traders.filter((t) => !t.enabled);
  const hasMirrorWallet = traders.length > 0;
  const mirrorWalletState = !hasMirrorWallet ? "not connected" : activeTraders.length > 0 ? "active" : "paused";
  const parsedBuyAmount = Number.parseFloat(buyAmount.replace(",", "."));
  const buyAmountUsd = Number.isFinite(parsedBuyAmount) && solPriceUsd > 0
    ? parsedBuyAmount * solPriceUsd
    : null;

  async function copyAddr(addr: string) {
    await navigator.clipboard.writeText(addr);
    setCopiedAddr(addr);
    window.setTimeout(() => setCopiedAddr((c) => (c === addr ? null : c)), 1200);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(buyAmount);
    if (hasMirrorWallet) { setAddError("Only one mirror wallet can be connected"); return; }
    if (!address.trim()) { setAddError("Wallet address is required"); return; }
    if (isNaN(amt) || amt <= 0) { setAddError("Buy amount must be > 0"); return; }
    setAddError("");
    setAddPending(true);
    const ok = await onAddTrader(address.trim(), label.trim(), amt);
    setAddPending(false);
    if (ok) { setAddress(""); setLabel(""); setBuyAmount("0.1"); }
  }

  function renderTraderRow(trader: MirrorTrader, paused: boolean) {
    return (
      <article
        key={trader.address}
        className={`trader-row mirror-trader-row${paused ? " paused" : ""}`}
      >
        <div className="wallet-icon">
          <Radio size={17} />
        </div>
        <div className="trader-meta">
          <div className="trader-address-line">
            <strong title={trader.address}>{trader.label || trader.address}</strong>
            <button
              className="trader-copy-button"
              type="button"
              aria-label="Copy address"
              onClick={() => copyAddr(trader.address)}
            >
              {copiedAddr === trader.address ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <a
              className="mirror-ext-link"
              href={solscanAddr(trader.address)}
              target="_blank"
              rel="noreferrer"
              title="View on Solscan"
            >
              <ExternalLink size={11} />
            </a>
          </div>
          <span>
            {trader.label ? shortAddr(trader.address) + " · " : ""}
            {new Date(trader.createdAt).toLocaleDateString()}
          </span>
        </div>
        <div className="mirror-buy-badge">
          <strong>{trader.buyAmountSol}</strong>
          <span>SOL/buy</span>
        </div>
        <button
          className={`icon-button trader-toggle-button${paused ? " resume" : " pause"}`}
          type="button"
          title={paused ? "Resume mirroring" : "Pause mirroring"}
          onClick={() => onUpdateTrader(trader.address, { enabled: paused })}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button
          className="icon-button"
          type="button"
          title="Remove trader"
          onClick={() => setRemoveConfirm(trader)}
        >
          <Trash2 size={16} />
        </button>
      </article>
    );
  }

  function getTokenLabel(pos: MirrorPosition | MirrorClosedPosition) {
    return pos.tokenName || pos.tokenSymbol;
  }

  function getTokenDetails(pos: MirrorPosition | MirrorClosedPosition) {
    return pos.tokenName
      ? `${pos.tokenSymbol} · ${shortAddr(pos.tokenMint)}`
      : shortAddr(pos.tokenMint);
  }

  const totalPositions = positions.length + closedPositions.length;

  return (
    <>
      <section className="trader-section mirror-section mirror-control-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Auto buy + sell</p>
            <h2>
              Mirror trading
              {status.enabled && <span className="mirror-running-badge">running</span>}
            </h2>
          </div>
          <button
            className={`trading-toggle${status.enabled ? " running" : ""}`}
            type="button"
            disabled={updatingMirror || (!status.enabled && !hasMirrorWallet)}
            title={!status.enabled && !hasMirrorWallet ? "Add mirror wallet first" : undefined}
            onClick={onToggleMirror}
          >
            {status.enabled ? "Stop mirror" : "Start mirror"}
          </button>
        </div>

        {!hasMirrorWallet && (
          <form className="mirror-form" onSubmit={handleAdd}>
            <label className="input-wrap">
              <span>Wallet address</span>
              <input
                value={address}
                placeholder="Paste Solana wallet address"
                onChange={(e) => { setAddress(e.target.value); setAddError(""); }}
              />
            </label>
            <label className="input-wrap">
              <span>Name (optional)</span>
              <input
                value={label}
                placeholder="Mirror wallet"
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label className="input-wrap mirror-sol-wrap">
              <span className="inline-label">
                SOL per buy
                <b title="Converted with current SOL/USD">{buyAmountUsd == null ? "$--" : formatUsd(buyAmountUsd)}</b>
              </span>
              <input
                inputMode="decimal"
                value={buyAmount}
                onChange={(e) => setBuyAmount(e.target.value)}
              />
            </label>
            <button className="primary-button mirror-add-btn" type="submit" disabled={addPending}>
              <Plus size={17} />
              {addPending ? "Adding…" : "Add"}
            </button>
          </form>
        )}
        {addError && <div className="form-error">{addError}</div>}
      </section>

      <section className="trader-section mirror-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Mirror wallet</p>
            <h2>
              Wallet
              <span>{mirrorWalletState}</span>
            </h2>
          </div>
        </div>

        {traders.length === 0 ? (
          <div className="empty-state">No mirror wallet connected</div>
        ) : (
          <>
            {activeTraders.length > 0 && (
              <>
                <div className="trader-group-label mirror-group-label">
                  Connected
                </div>
                <div className="trader-list">
                  {activeTraders.map((t) => renderTraderRow(t, false))}
                </div>
              </>
            )}

            {pausedTraders.length > 0 && (
              <>
                <div className="trader-group-label paused mirror-group-label compact">
                  Paused
                  <span className="trader-group-count">{pausedTraders.length}</span>
                </div>
                <div className="trader-list">
                  {pausedTraders.map((t) => renderTraderRow(t, true))}
                </div>
              </>
            )}
          </>
        )}
      </section>

      <section className="positions-section mirror-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Mirror positions</p>
            <h2>
              Positions
              <span>{positions.length} open / {closedPositions.length} closed</span>
            </h2>
          </div>
        </div>

        <div className="positions-list mirror-positions-list">
              {totalPositions === 0 ? (
                <div className="empty-state">No positions yet</div>
              ) : (
                <>
                  {positions.map((pos) => {
                    const tokenLabel = getTokenLabel(pos);
                    const tokenDetails = getTokenDetails(pos);
                    const pnlPercent = pos.entryPriceUsd > 0
                      ? ((pos.currentPriceUsd / pos.entryPriceUsd) - 1) * 100
                      : 0;

                    return (
                    <article key={pos.id} className="position-row active mirror-position-row">
                      <TokenIcon mint={pos.tokenMint} symbol={pos.tokenSymbol} tokenImage={pos.tokenImage} />
                      <div className="position-token">
                        <div className="position-token-text">
                          <strong title={tokenLabel}>{tokenLabel}</strong>
                          <span title={pos.tokenMint}>{tokenDetails}</span>
                        </div>
                        <button
                          className="position-copy-button"
                          type="button"
                          aria-label="Copy token mint"
                          title="Copy token mint"
                          onClick={() => copyAddr(pos.tokenMint)}
                        >
                          {copiedAddr === pos.tokenMint ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                      <div className="position-cell">
                        <span>Entry</span>
                        <strong>{formatUsd(pos.entryPriceUsd)}</strong>
                      </div>
                      <div className="position-cell">
                        <span>Current</span>
                        <strong>{formatUsd(pos.currentPriceUsd)}</strong>
                      </div>
                      <div className={`position-pnl ${pnlPercent >= 0 ? "positive" : "negative"}`}>
                        <strong>{pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%</strong>
                        <span>open</span>
                      </div>
                      <div className="position-cell">
                        <span>Amount</span>
                        <strong>{formatNumber(pos.tokenAmount)}</strong>
                      </div>
                      <div className="platform-pill">Mirror</div>
                      <button
                        className="sell-button"
                        type="button"
                        disabled={sellPending === pos.id}
                        onClick={() => setSellConfirm(pos)}
                      >
                        {sellPending === pos.id ? "…" : "Sell"}
                      </button>
                    </article>
                    );
                  })}

                  {closedPositions.map((pos) => {
                    const pnl = pos.solReceived != null ? pos.solReceived - pos.solSpent : null;
                    const pct = pnl != null && pos.solSpent > 0 ? (pnl / pos.solSpent) * 100 : null;
                    const tokenLabel = getTokenLabel(pos);
                    const tokenDetails = getTokenDetails(pos);
                    return (
                      <article key={pos.id} className="position-row closed mirror-position-row mirror-position-closed">
                        <TokenIcon mint={pos.tokenMint} symbol={pos.tokenSymbol} tokenImage={pos.tokenImage} />
                        <div className="position-token">
                          <div className="position-token-text">
                            <strong title={tokenLabel}>{tokenLabel}</strong>
                            <span title={pos.tokenMint}>{tokenDetails}</span>
                          </div>
                          <button
                            className="position-copy-button"
                            type="button"
                            aria-label="Copy token mint"
                            title="Copy token mint"
                            onClick={() => copyAddr(pos.tokenMint)}
                          >
                            {copiedAddr === pos.tokenMint ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                        </div>
                        <div className="position-cell">
                          <span>Entry</span>
                          <strong>{formatUsd(pos.entryPriceUsd)}</strong>
                        </div>
                        <div className="position-cell">
                          <span>Exit</span>
                          <strong>{formatUsd(pos.exitPriceUsd)}</strong>
                        </div>
                        <div className={`position-pnl ${pnl == null || pnl >= 0 ? "positive" : "negative"}`}>
                          {pnl != null ? (
                            <>
                              <strong>{pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}</strong>
                              <span>{pnl >= 0 ? "+" : ""}{formatSol(pnl)} SOL</span>
                            </>
                          ) : (
                            <>
                              <strong>—</strong>
                              <span>closed</span>
                            </>
                          )}
                        </div>
                        <div className="position-cell">
                          <span>Closed</span>
                          <strong>{formatDistanceToNow(new Date(pos.closedAt))}</strong>
                        </div>
                        <div className={`position-cell sol-result ${pnl == null || pnl >= 0 ? "positive" : "negative"}`}>
                          <span>Net SOL</span>
                          <strong>{pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${formatSol(pnl)}`}</strong>
                          <small>{pos.solReceived != null ? `${formatSol(pos.solReceived)} out` : ""}</small>
                        </div>
                        <div className="close-meta mirror-close-meta">
                          <div className="platform-stack">
                            <span>Mirror</span>
                            <strong>{pos.closeReason === "mirror-sell" ? "Jupiter" : pos.closeReason}</strong>
                          </div>
                          {pos.sellTx ? (
                            <a
                              className="reason-pill mirror-tx-pill"
                              href={solscanTx(pos.sellTx)}
                              target="_blank"
                              rel="noreferrer"
                              title={pos.sellTx}
                            >
                              Tx
                              <ExternalLink size={11} />
                            </a>
                          ) : (
                            <div className="reason-pill">{pos.closeReason}</div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </>
              )}
        </div>
      </section>

      {/* Sell confirmation */}
      {sellConfirm && (
        <ConfirmModal
          title={`Sell ${sellConfirm.tokenSymbol}?`}
          description={`Sell all ${sellConfirm.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens via Jupiter`}
          confirmLabel="Sell"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={() => { onSellPosition(sellConfirm.id); setSellConfirm(null); }}
          onCancel={() => setSellConfirm(null)}
        />
      )}

      {/* Remove trader confirmation */}
      {removeConfirm && (
        <ConfirmModal
          title="Remove mirror wallet?"
          description={`${removeConfirm.label || shortAddr(removeConfirm.address)} will no longer be mirrored`}
          confirmLabel="Remove"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={() => { onRemoveTrader(removeConfirm.address); setRemoveConfirm(null); }}
          onCancel={() => setRemoveConfirm(null)}
        />
      )}
    </>
  );
}
