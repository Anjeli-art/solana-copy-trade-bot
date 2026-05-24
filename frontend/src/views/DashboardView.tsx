import type { BotWallet, Position } from "../types";
import { BotWalletCard } from "../components/BotWalletCard";
import { ProfitSettings } from "../components/ProfitSettings";
import { PositionsView } from "./PositionsView";

type DashboardViewProps = {
  botWallet: BotWallet;
  positions: Position[];
  takeProfit: number;
  draftTakeProfit: number;
  highTakeProfit: number;
  draftHighTakeProfit: number;
  stopLoss: number;
  draftStopLoss: number;
  positionTimeoutMinutes: number;
  draftPositionTimeoutMinutes: number;
  buyAmountSol: number;
  draftBuyAmountSol: number;
  solPriceUsd: number;
  isWalletRefreshing: boolean;
  setDraftTakeProfit: (value: number) => void;
  setDraftHighTakeProfit: (value: number) => void;
  setDraftStopLoss: (value: number) => void;
  setDraftPositionTimeoutMinutes: (value: number) => void;
  setDraftBuyAmountSol: (value: number) => void;
  onRefreshWallet: () => void;
  onSaveTakeProfit: () => void;
  onSellPosition: (id: string) => void;
  onMoveProfitTier: (id: string, profitTier: "low" | "high") => void;
};

export function DashboardView({
  botWallet,
  positions,
  takeProfit,
  draftTakeProfit,
  highTakeProfit,
  draftHighTakeProfit,
  stopLoss,
  draftStopLoss,
  positionTimeoutMinutes,
  draftPositionTimeoutMinutes,
  buyAmountSol,
  draftBuyAmountSol,
  solPriceUsd,
  isWalletRefreshing,
  setDraftTakeProfit,
  setDraftHighTakeProfit,
  setDraftStopLoss,
  setDraftPositionTimeoutMinutes,
  setDraftBuyAmountSol,
  onRefreshWallet,
  onSaveTakeProfit,
  onSellPosition,
  onMoveProfitTier
}: DashboardViewProps) {
  return (
    <>
      <BotWalletCard wallet={botWallet} isRefreshing={isWalletRefreshing} onRefresh={onRefreshWallet} />
      <ProfitSettings
        takeProfit={takeProfit}
        draftTakeProfit={draftTakeProfit}
        highTakeProfit={highTakeProfit}
        draftHighTakeProfit={draftHighTakeProfit}
        stopLoss={stopLoss}
        draftStopLoss={draftStopLoss}
        positionTimeoutMinutes={positionTimeoutMinutes}
        draftPositionTimeoutMinutes={draftPositionTimeoutMinutes}
        buyAmountSol={buyAmountSol}
        draftBuyAmountSol={draftBuyAmountSol}
        solPriceUsd={solPriceUsd}
        setDraftTakeProfit={setDraftTakeProfit}
        setDraftHighTakeProfit={setDraftHighTakeProfit}
        setDraftStopLoss={setDraftStopLoss}
        setDraftPositionTimeoutMinutes={setDraftPositionTimeoutMinutes}
        setDraftBuyAmountSol={setDraftBuyAmountSol}
        onSave={onSaveTakeProfit}
      />
      <PositionsView
        positions={positions}
        compact
        onSellPosition={onSellPosition}
        onMoveProfitTier={onMoveProfitTier}
      />
    </>
  );
}
