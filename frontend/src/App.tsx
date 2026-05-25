import { useEffect, useMemo, useState } from "react";
import { MetricsGrid } from "./components/MetricsGrid";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useAnalytics } from "./hooks/useAnalytics";
import { useAppRoute } from "./hooks/useAppRoute";
import { useBotState } from "./hooks/useBotState";
import { useLogs } from "./hooks/useLogs";
import { useMirrorState } from "./hooks/useMirrorState";
import { useTraderManagement } from "./hooks/useTraderManagement";
import { useTradingStatus } from "./hooks/useTradingStatus";
import { AnalyticsView } from "./views/AnalyticsView";
import { DashboardView } from "./views/DashboardView";
import { LogsView } from "./views/LogsView";
import { MirrorView } from "./views/MirrorView";
import { PositionsView } from "./views/PositionsView";
import { TradersView } from "./views/TradersView";

export function App() {
  const [apiError, setApiError] = useState("");
  const { activeView, navigateToView } = useAppRoute();
  const { analytics, manualTokenAnalytics, mirrorAnalytics, salesByDay, salesByHour, refreshAnalytics } = useAnalytics(setApiError);
  const botState = useBotState(setApiError, refreshAnalytics);
  const trading = useTradingStatus(setApiError);
  const logsState = useLogs(setApiError);
  const mirrorState = useMirrorState(setApiError);
  const traderForm = useTraderManagement(botState.traders, botState.setTraders);
  const solPriceUsd = botState.wallet.solPriceUsd;

  const traderCount = useMemo(() => botState.traders.filter((t) => t.enabled !== false).length, [botState.traders]);
  const openPositions = botState.positions.length;

  useEffect(() => {
    const stateTimer = window.setInterval(() => {
      botState.refreshState();
      refreshAnalytics();
    }, trading.hasActiveAutomation ? 10000 : 30000);

    const refreshVisibleState = () => {
      if (document.visibilityState === "visible") {
        botState.refreshState();
        refreshAnalytics();
      }
    };

    window.addEventListener("focus", refreshVisibleState);
    document.addEventListener("visibilitychange", refreshVisibleState);

    return () => {
      window.clearInterval(stateTimer);
      window.removeEventListener("focus", refreshVisibleState);
      document.removeEventListener("visibilitychange", refreshVisibleState);
    };
  }, [botState.refreshState, refreshAnalytics, trading.hasActiveAutomation]);

  return (
    <main className="app-shell">
      <Sidebar activeView={activeView} onViewChange={navigateToView} />
      <section className="workspace">
        <Topbar
          copyEnabled={trading.copyEnabled}
          profitEnabled={trading.profitEnabled}
          updatingMode={trading.updatingTradingMode}
          onToggleCopy={trading.toggleCopyTrading}
          onToggleProfit={trading.toggleProfitWatcher}
        />
        {apiError ? <div className="api-error">{apiError}</div> : null}
        {botState.isLoading ? <div className="loading-state">Loading backend state</div> : null}
        {botState.hasLoadedState ? (
          <MetricsGrid
            openPositions={openPositions}
            traderCount={traderCount}
            takeProfit={botState.takeProfit}
            highTakeProfit={botState.highTakeProfit}
            buyAmountSol={botState.buyAmountSol}
            copyEnabled={trading.copyEnabled}
            profitEnabled={trading.profitEnabled}
            mirrorEnabled={mirrorState.status.enabled}
            mirrorPositions={mirrorState.positions.length}
          />
        ) : null}
        {botState.hasLoadedState && activeView === "dashboard" ? (
          <DashboardView
            botWallet={{ ...botState.wallet, solPriceUsd }}
            positions={botState.positions}
            takeProfit={botState.takeProfit}
            draftTakeProfit={botState.draftTakeProfit}
            highTakeProfit={botState.highTakeProfit}
            draftHighTakeProfit={botState.draftHighTakeProfit}
            stopLoss={botState.stopLoss}
            draftStopLoss={botState.draftStopLoss}
            positionTimeoutMinutes={botState.positionTimeoutMinutes}
            draftPositionTimeoutMinutes={botState.draftPositionTimeoutMinutes}
            buyAmountSol={botState.buyAmountSol}
            draftBuyAmountSol={botState.draftBuyAmountSol}
            solPriceUsd={solPriceUsd}
            isWalletRefreshing={botState.isWalletRefreshing}
            setDraftTakeProfit={botState.setDraftTakeProfit}
            setDraftHighTakeProfit={botState.setDraftHighTakeProfit}
            setDraftStopLoss={botState.setDraftStopLoss}
            setDraftPositionTimeoutMinutes={botState.setDraftPositionTimeoutMinutes}
            setDraftBuyAmountSol={botState.setDraftBuyAmountSol}
            onRefreshWallet={botState.refreshBotWallet}
            onSaveTakeProfit={botState.saveTradingSettings}
            onSellPosition={botState.sellPosition}
            onMoveProfitTier={botState.movePositionProfitTier}
          />
        ) : null}
        {botState.hasLoadedState && activeView === "positions" ? (
          <PositionsView
            positions={botState.positions}
            closedPositions={botState.closedPositions}
            solPriceUsd={solPriceUsd}
            manualRepeatTokens={botState.manualRepeatTokens}
            blacklistedTokens={botState.blacklistedTokens}
            repeatBuyingMint={botState.repeatBuyingMint}
            onRepeatBuyToken={botState.repeatBuyKnownToken}
            onDeleteManualToken={botState.removeManualRepeatToken}
            onAddBlacklistedToken={botState.blockToken}
            onDeleteBlacklistedToken={botState.unblockToken}
            onSellPosition={botState.sellPosition}
            onMoveProfitTier={botState.movePositionProfitTier}
          />
        ) : null}
        {botState.hasLoadedState && activeView === "traders" ? (
          <TradersView
            traders={botState.traders}
            walletAddress={traderForm.walletAddress}
            error={traderForm.error}
            setWalletAddress={traderForm.setWalletAddress}
            setError={traderForm.setError}
            addTrader={traderForm.addTrader}
            removeTrader={traderForm.removeTrader}
            toggleTrader={traderForm.toggleTrader}
          />
        ) : null}
        {botState.hasLoadedState && activeView === "analytics" ? (
          <AnalyticsView
            traders={analytics}
            manualTokens={manualTokenAnalytics}
            mirrorTraders={mirrorAnalytics}
            salesByDay={salesByDay}
            salesByHour={salesByHour}
          />
        ) : null}
        {botState.hasLoadedState && activeView === "logs" ? (
          <LogsView
            logs={logsState.logs}
            eventOptions={logsState.logEvents}
            eventFilter={logsState.logEventFilter}
            isRefreshing={logsState.isLogsRefreshing}
            onEventFilterChange={logsState.changeLogEventFilter}
            onDeleteLog={logsState.removeLog}
            onDeleteAllByEvent={logsState.removeLogsByEvent}
            onRefresh={() => logsState.refreshLogs()}
          />
        ) : null}
        {activeView === "mirror" ? (
          <MirrorView
            status={mirrorState.status}
            traders={mirrorState.traders}
            positions={mirrorState.positions}
            closedPositions={mirrorState.closedPositions}
            updatingMirror={mirrorState.updatingMirror}
            sellPending={mirrorState.sellPending}
            solPriceUsd={solPriceUsd}
            onToggleMirror={mirrorState.toggleMirror}
            onAddTrader={mirrorState.addTrader}
            onRemoveTrader={mirrorState.removeTrader}
            onUpdateTrader={mirrorState.updateTrader}
            onSellPosition={mirrorState.sellPosition}
          />
        ) : null}
      </section>
    </main>
  );
}
