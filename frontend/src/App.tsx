import { useEffect, useMemo, useState } from "react";
import { MetricsGrid } from "./components/MetricsGrid";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useAnalytics } from "./hooks/useAnalytics";
import { useAppRoute } from "./hooks/useAppRoute";
import { useBotState } from "./hooks/useBotState";
import { useLogs } from "./hooks/useLogs";
import { useSolPrice } from "./hooks/useSolPrice";
import { useTraderManagement } from "./hooks/useTraderManagement";
import { useTradingStatus } from "./hooks/useTradingStatus";
import { AnalyticsView } from "./views/AnalyticsView";
import { DashboardView } from "./views/DashboardView";
import { LogsView } from "./views/LogsView";
import { PositionsView } from "./views/PositionsView";
import { TradersView } from "./views/TradersView";

export function App() {
  const [apiError, setApiError] = useState("");
  const { activeView, navigateToView } = useAppRoute();
  const { analytics, manualTokenAnalytics, salesByDay, salesByHour, refreshAnalytics } = useAnalytics(setApiError);
  const botState = useBotState(setApiError, refreshAnalytics);
  const trading = useTradingStatus(setApiError);
  const logsState = useLogs(setApiError);
  const traderForm = useTraderManagement(botState.traders, botState.setTraders);
  const solPriceUsd = useSolPrice(botState.wallet.solPriceUsd);

  const traderCount = useMemo(() => botState.traders.length, [botState.traders.length]);
  const openPositions = botState.positions.length;

  useEffect(() => {
    const stateTimer = window.setInterval(() => {
      botState.refreshState();
      refreshAnalytics();
    }, trading.hasActiveAutomation ? 30000 : 60000);

    return () => {
      window.clearInterval(stateTimer);
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
          />
        ) : null}
        {botState.hasLoadedState && activeView === "analytics" ? (
          <AnalyticsView
            traders={analytics}
            manualTokens={manualTokenAnalytics}
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
            onRefresh={() => logsState.refreshLogs()}
          />
        ) : null}
      </section>
    </main>
  );
}
