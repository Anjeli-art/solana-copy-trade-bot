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

function shortAddr(addr?: string | null) {
  if (!addr) {
    return "-";
  }
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

  async function copyAddr(addr?: string | null) {
    if (!addr) {
      return;
    }
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
          <div className="mirror-buy-main">
            <strong>{trader.buyAmountSol}</strong>
            {solPriceUsd > 0 && (
              <span className="mirror-buy-usd">
                ≈ ${(trader.buyAmountSol * solPriceUsd).toFixed(2)}
              </span>
            )}
          </div>
          <span className="mirror-buy-label">SOL/buy</span>
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
    // Fall back through tokenName → tokenSymbol → short mint → "—" so a position
    // with missing metadata (e.g. brand-new mint Helius didn't index yet) never
    // renders `undefined` or, worse, crashes the row via .slice on undefined.
    return pos?.tokenName || pos?.tokenSymbol || shortAddr(pos?.tokenMint) || "—";
  }

  function getTokenDetails(pos: MirrorPosition | MirrorClosedPosition) {
    if (!pos) return "—";
    return pos.tokenName
      ? `${pos.tokenSymbol || ""} · ${shortAddr(pos.tokenMint)}`
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
                      <div className="platform-pill" title={pos.monitorType ? `Native: ${pos.monitorType}` : "Jupiter fallback"}>
                        {pos.buyPlatform || "Mirror"}
                      </div>
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
                    // ATA rent is a deposit, not a cost — credit it back to PnL so the
                    // wallet-level view matches what's shown here.
                    const rentRecovered = pos.ataRentRecovered ?? 0;
                    const pnl = pos.solReceived != null
                      ? pos.solReceived + rentRecovered - pos.solSpent
                      : null;
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
                              <span>—</span>
                            </>
                          )}
                        </div>
                        <div className={`position-cell sol-result ${pnl == null || pnl >= 0 ? "positive" : "negative"}`}>
                          <span>Net SOL</span>
                          <strong>{pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${formatSol(pnl)}`}</strong>
                          <small>{pos.solReceived != null ? `${formatSol(pos.solReceived)} out` : ""}</small>
                        </div>
                        <div className="close-meta mirror-close-meta">
                          {(() => {
                            // Top line: where the position was bought.
                            // Bottom line: how it was closed.
                            // We ALWAYS show a close-reason badge now — previously "mirror-sell"
                            // was suppressed, which made auto vs manual visually indistinguishable.
                            // Friendlier labels: "mirror-sell" → "auto", anything else → as-is.
                            const buyLabel = pos.buyPlatform || "Mirror";
                            const exitLabel = pos.exitPlatform || null;
                            const samePlatform = exitLabel && buyLabel === exitLabel;
                            const friendlyReason = (() => {
                              if (!pos.closeReason) return null;
                              if (pos.closeReason === "mirror-sell") return "auto";
                              return pos.closeReason;
                            })();
                            // If buy/exit platforms differ, the exit platform is the most
                            // informative bottom line. Otherwise show the close reason badge.
                            const bottomLine = !samePlatform && exitLabel
                              ? exitLabel
                              : friendlyReason;
                            return (
                              <div className="platform-stack">
                                <span>{buyLabel}</span>
                                {bottomLine && <strong>{bottomLine}</strong>}
                              </div>
                            );
                          })()}
                          <div className="mirror-tx-stack">
                            <small className="mirror-closed-at">Closed · {formatDistanceToNow(new Date(pos.closedAt))}</small>
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
                        </div>
                      </article>
                    );
                  })}
                </>
              )}
        </div>
      </section>

      {/* Sell confirmation */}
      {sellConfirm && (() => {
        // Defensive formatting: if tokenAmount comes back as undefined/NaN (e.g. a partial
        // backend response after a failed sell), don't crash the whole tree on .toLocaleString.
        const amt = Number(sellConfirm.tokenAmount);
        const amtStr = Number.isFinite(amt)
          ? amt.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : "all";
        const sym = sellConfirm.tokenSymbol || shortAddr(sellConfirm.tokenMint);
        // Pick the route label honestly — we go native if we know the platform, otherwise
        // Jupiter is the fallback. The old text said "via Jupiter" unconditionally, which
        // was a lie for Pump.fun / PumpSwap / Raydium / Orca native sells.
        const route = sellConfirm.monitorType
          ? `via ${sellConfirm.buyPlatform || sellConfirm.monitorType}`
          : "via Jupiter";
        return (
          <ConfirmModal
            title={`Sell ${sym}?`}
            description={`Sell all ${amtStr} tokens ${route}`}
            confirmLabel="Sell"
            cancelLabel="Cancel"
            variant="danger"
            onConfirm={() => { onSellPosition(sellConfirm.id); setSellConfirm(null); }}
            onCancel={() => setSellConfirm(null)}
          />
        );
      })()}

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
