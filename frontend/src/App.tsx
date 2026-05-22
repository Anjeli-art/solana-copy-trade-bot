import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  addTrackedTrader,
  closeActivePosition,
  deleteLog,
  deleteManualRepeatToken,
  deleteTrackedTrader,
  getLogEvents,
  getLogs,
  getManualRepeatTokens,
  getManualTokenAnalytics,
  getTraderAnalytics,
  getTradingStatus,
  getState,
  refreshWallet,
  repeatBuyToken,
  saveSettings,
  startCopyTrading,
  startProfitWatcher,
  stopCopyTrading,
  stopProfitWatcher
} from "./api/client";
import { MetricsGrid } from "./components/MetricsGrid";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import type {
  BotLog,
  BotWallet,
  ClosedPosition,
  ManualRepeatToken,
  ManualTokenAnalytics,
  Position,
  Trader,
  TraderAnalytics,
  View
} from "./types";
import { AnalyticsView } from "./views/AnalyticsView";
import { DashboardView } from "./views/DashboardView";
import { LogsView } from "./views/LogsView";
import { PositionsView } from "./views/PositionsView";
import { TradersView } from "./views/TradersView";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SOL_MINT = "So11111111111111111111111111111111111111112";

const EMPTY_WALLET: BotWallet = {
  address: "",
  solBalance: 0,
  solPriceUsd: 0,
  realizedPnlTodayUsd: 0,
  lastUpdated: new Date(0).toISOString()
};

export function App() {
  const [activeView, setActiveView] = useState<View>("dashboard");
  const [traders, setTraders] = useState<Trader[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([]);
  const [logs, setLogs] = useState<BotLog[]>([]);
  const [logEvents, setLogEvents] = useState<string[]>([]);
  const [logEventFilter, setLogEventFilter] = useState("all");
  const [manualRepeatTokens, setManualRepeatTokens] = useState<ManualRepeatToken[]>([]);
  const [analytics, setAnalytics] = useState<TraderAnalytics[]>([]);
  const [manualTokenAnalytics, setManualTokenAnalytics] = useState<ManualTokenAnalytics[]>([]);
  const [wallet, setWallet] = useState<BotWallet>(EMPTY_WALLET);
  const [fallbackSolPriceUsd, setFallbackSolPriceUsd] = useState(0);
  const [walletAddress, setWalletAddress] = useState("");
  const [takeProfit, setTakeProfit] = useState(1.5);
  const [draftTakeProfit, setDraftTakeProfit] = useState(1.5);
  const [stopLoss, setStopLoss] = useState(0.7);
  const [draftStopLoss, setDraftStopLoss] = useState(0.7);
  const [positionTimeoutMinutes, setPositionTimeoutMinutes] = useState(120);
  const [draftPositionTimeoutMinutes, setDraftPositionTimeoutMinutes] = useState(120);
  const [buyAmountSol, setBuyAmountSol] = useState(0.03);
  const [draftBuyAmountSol, setDraftBuyAmountSol] = useState(0.03);
  const [error, setError] = useState("");
  const [apiError, setApiError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadedState, setHasLoadedState] = useState(false);
  const [isWalletRefreshing, setIsWalletRefreshing] = useState(false);
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [profitEnabled, setProfitEnabled] = useState(false);
  const [updatingTradingMode, setUpdatingTradingMode] = useState<"copy" | "profit" | null>(null);
  const [isLogsRefreshing, setIsLogsRefreshing] = useState(false);
  const [repeatBuyingMint, setRepeatBuyingMint] = useState<string | null>(null);
  const didLoadLogEvents = useRef(false);

  const traderCount = useMemo(() => traders.length, [traders]);
  const openPositions = positions.length;
  const solPriceUsd = wallet.solPriceUsd || fallbackSolPriceUsd;
  const hasActiveAutomation = copyEnabled || profitEnabled;

  async function refreshState() {
    try {
      setApiError("");
      const state = await getState();
      setTraders(state.trackedTraders);
      setPositions(state.activePositions);
      setClosedPositions(state.closedPositions);
      setWallet(state.wallet);
      setTakeProfit(state.settings.profitTargetMultiplier);
      setDraftTakeProfit(state.settings.profitTargetMultiplier);
      setStopLoss(state.settings.stopLossMultiplier);
      setDraftStopLoss(state.settings.stopLossMultiplier);
      setPositionTimeoutMinutes(state.settings.positionTimeoutMinutes);
      setDraftPositionTimeoutMinutes(state.settings.positionTimeoutMinutes);
      setBuyAmountSol(state.settings.buyAmountSol);
      setDraftBuyAmountSol(state.settings.buyAmountSol);
      setManualRepeatTokens(await getManualRepeatTokens());
      setHasLoadedState(true);
    } catch (fetchError) {
      setApiError(fetchError instanceof Error ? fetchError.message : "Backend API unavailable");
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshLogEvents() {
    if (didLoadLogEvents.current) {
      return;
    }

    didLoadLogEvents.current = true;
    try {
      const nextEvents = await getLogEvents();
      setLogEvents(nextEvents);
    } catch (fetchError) {
      didLoadLogEvents.current = false;
      setApiError(fetchError instanceof Error ? fetchError.message : "Failed to load log events");
    }
  }

  async function refreshLogs(eventFilter = logEventFilter) {
    try {
      setApiError("");
      setIsLogsRefreshing(true);
      const nextLogs = await getLogs(200, eventFilter === "all" ? undefined : eventFilter);
      setLogs(nextLogs);
    } catch (fetchError) {
      setApiError(fetchError instanceof Error ? fetchError.message : "Failed to load logs");
    } finally {
      setIsLogsRefreshing(false);
    }
  }

  async function refreshAnalytics() {
    try {
      setApiError("");
      const nextAnalytics = await getTraderAnalytics();
      const nextManualTokenAnalytics = await getManualTokenAnalytics();
      setAnalytics(nextAnalytics);
      setManualTokenAnalytics(nextManualTokenAnalytics);
    } catch (fetchError) {
      setApiError(fetchError instanceof Error ? fetchError.message : "Failed to load analytics");
    }
  }

  useEffect(() => {
    refreshState();
    refreshLogs();
    refreshLogEvents();
    refreshAnalytics();
  }, []);

  useEffect(() => {
    async function refreshTradingStatus() {
      try {
        const status = await getTradingStatus();
        setCopyEnabled(status.copyEnabled);
        setProfitEnabled(status.profitEnabled);
      } catch {
        setCopyEnabled(false);
        setProfitEnabled(false);
      }
    }

    refreshTradingStatus();
  }, []);

  useEffect(() => {
    const logsTimer = window.setInterval(() => {
      refreshLogs();
    }, 20000);

    const stateTimer = window.setInterval(() => {
      refreshState();
      refreshAnalytics();
    }, hasActiveAutomation ? 30000 : 60000);

    return () => {
      window.clearInterval(logsTimer);
      window.clearInterval(stateTimer);
    };
  }, [hasActiveAutomation, logEventFilter]);

  useEffect(() => {
    if (wallet.solPriceUsd > 0) {
      return;
    }

    let isMounted = true;

    async function loadSolPrice() {
      try {
        const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
        const payload = (await response.json()) as Record<string, { usdPrice?: number }>;
        const price = payload[SOL_MINT]?.usdPrice;

        if (isMounted && typeof price === "number" && Number.isFinite(price) && price > 0) {
          setFallbackSolPriceUsd(price);
        }
      } catch {
        if (isMounted) {
          setFallbackSolPriceUsd(0);
        }
      }
    }

    loadSolPrice();

    return () => {
      isMounted = false;
    };
  }, [wallet.solPriceUsd]);

  async function addTrader(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const address = walletAddress.trim();
    if (address.length < 32 || address.length > 44 || !BASE58_RE.test(address)) {
      setError("Invalid wallet address");
      return;
    }

    if (traders.some((trader) => trader.address === address)) {
      setError("Wallet already tracked");
      return;
    }

    try {
      setError("");
      const nextTraders = await addTrackedTrader(address);
      setTraders(nextTraders);
      setWalletAddress("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to add wallet");
    }
  }

  async function removeTrader(address: string) {
    try {
      const nextTraders = await deleteTrackedTrader(address);
      setTraders(nextTraders);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to remove wallet");
    }
  }

  async function saveTradingSettings() {
    try {
      setApiError("");
      const settings = await saveSettings({
        profitTargetMultiplier: draftTakeProfit,
        stopLossMultiplier: draftStopLoss,
        positionTimeoutMinutes: draftPositionTimeoutMinutes,
        buyAmountSol: draftBuyAmountSol
      });
      setTakeProfit(settings.profitTargetMultiplier);
      setDraftTakeProfit(settings.profitTargetMultiplier);
      setStopLoss(settings.stopLossMultiplier);
      setDraftStopLoss(settings.stopLossMultiplier);
      setPositionTimeoutMinutes(settings.positionTimeoutMinutes);
      setDraftPositionTimeoutMinutes(settings.positionTimeoutMinutes);
      setBuyAmountSol(settings.buyAmountSol);
      setDraftBuyAmountSol(settings.buyAmountSol);
      await refreshState();
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to save trading settings");
    }
  }

  async function refreshBotWallet() {
    try {
      setApiError("");
      setIsWalletRefreshing(true);
      const nextWallet = await refreshWallet();
      setWallet(nextWallet);
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to refresh wallet");
    } finally {
      setIsWalletRefreshing(false);
    }
  }

  async function toggleCopyTrading() {
    try {
      setApiError("");
      setUpdatingTradingMode("copy");
      const status = copyEnabled ? await stopCopyTrading() : await startCopyTrading();
      setCopyEnabled(status.copyEnabled);
      setProfitEnabled(status.profitEnabled);
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to update auto buy");
    } finally {
      setUpdatingTradingMode(null);
    }
  }

  async function toggleProfitWatcher() {
    try {
      setApiError("");
      setUpdatingTradingMode("profit");
      const status = profitEnabled ? await stopProfitWatcher() : await startProfitWatcher();
      setCopyEnabled(status.copyEnabled);
      setProfitEnabled(status.profitEnabled);
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to update auto sell");
    } finally {
      setUpdatingTradingMode(null);
    }
  }

  async function sellPosition(id: string) {
    try {
      setApiError("");
      const result = await closeActivePosition(id);
      setPositions(result.activePositions);
      setClosedPositions(result.closedPositions);
      setWallet(result.wallet);
      await refreshAnalytics();
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to close position");
    }
  }

  async function repeatBuyKnownToken(tokenMint: string) {
    try {
      setApiError("");
      setRepeatBuyingMint(tokenMint);
      const result = await repeatBuyToken(tokenMint, buyAmountSol);
      setPositions(result.activePositions);
      setClosedPositions(result.closedPositions);
      setWallet(result.wallet);
      setManualRepeatTokens(await getManualRepeatTokens());
      await refreshAnalytics();
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to repeat buy token");
    } finally {
      setRepeatBuyingMint(null);
    }
  }

  async function removeLog(id: string) {
    try {
      setApiError("");
      await deleteLog(id);
      setLogs((current) => current.filter((log) => log.id !== id));
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to delete log");
    }
  }

  async function removeManualRepeatToken(tokenMint: string) {
    try {
      setApiError("");
      await deleteManualRepeatToken(tokenMint);
      setManualRepeatTokens((current) => current.filter((token) => token.tokenMint !== tokenMint));
    } catch (submitError) {
      setApiError(submitError instanceof Error ? submitError.message : "Failed to delete manual token");
    }
  }

  async function changeLogEventFilter(nextEvent: string) {
    setLogEventFilter(nextEvent);
    await refreshLogs(nextEvent);
  }

  return (
    <main className="app-shell">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      <section className="workspace">
        <Topbar
          copyEnabled={copyEnabled}
          profitEnabled={profitEnabled}
          updatingMode={updatingTradingMode}
          onToggleCopy={toggleCopyTrading}
          onToggleProfit={toggleProfitWatcher}
        />
        {apiError ? <div className="api-error">{apiError}</div> : null}
        {isLoading ? <div className="loading-state">Loading backend state</div> : null}
        {hasLoadedState ? (
          <MetricsGrid
            openPositions={openPositions}
            traderCount={traderCount}
            takeProfit={takeProfit}
            buyAmountSol={buyAmountSol}
          />
        ) : null}
        {hasLoadedState && activeView === "dashboard" ? (
          <DashboardView
            botWallet={{ ...wallet, solPriceUsd }}
            positions={positions}
            takeProfit={takeProfit}
            draftTakeProfit={draftTakeProfit}
            stopLoss={stopLoss}
            draftStopLoss={draftStopLoss}
            positionTimeoutMinutes={positionTimeoutMinutes}
            draftPositionTimeoutMinutes={draftPositionTimeoutMinutes}
            buyAmountSol={buyAmountSol}
            draftBuyAmountSol={draftBuyAmountSol}
            solPriceUsd={solPriceUsd}
            isWalletRefreshing={isWalletRefreshing}
            setDraftTakeProfit={setDraftTakeProfit}
            setDraftStopLoss={setDraftStopLoss}
            setDraftPositionTimeoutMinutes={setDraftPositionTimeoutMinutes}
            setDraftBuyAmountSol={setDraftBuyAmountSol}
            onRefreshWallet={refreshBotWallet}
            onSaveTakeProfit={saveTradingSettings}
            onSellPosition={sellPosition}
          />
        ) : null}
        {hasLoadedState && activeView === "positions" ? (
          <PositionsView
            positions={positions}
            closedPositions={closedPositions}
            manualRepeatTokens={manualRepeatTokens}
            repeatBuyingMint={repeatBuyingMint}
            onRepeatBuyToken={repeatBuyKnownToken}
            onDeleteManualToken={removeManualRepeatToken}
            onSellPosition={sellPosition}
          />
        ) : null}
        {hasLoadedState && activeView === "traders" ? (
          <TradersView
            traders={traders}
            walletAddress={walletAddress}
            error={error}
            setWalletAddress={setWalletAddress}
            setError={setError}
            addTrader={addTrader}
            removeTrader={removeTrader}
          />
        ) : null}
        {hasLoadedState && activeView === "analytics" ? (
          <AnalyticsView traders={analytics} manualTokens={manualTokenAnalytics} />
        ) : null}
        {hasLoadedState && activeView === "logs" ? (
          <LogsView
            logs={logs}
            eventOptions={logEvents}
            eventFilter={logEventFilter}
            isRefreshing={isLogsRefreshing}
            onEventFilterChange={changeLogEventFilter}
            onDeleteLog={removeLog}
            onRefresh={() => refreshLogs()}
          />
        ) : null}
      </section>
    </main>
  );
}
