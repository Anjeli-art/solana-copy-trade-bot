import type { BotWallet, Position } from "../types";
import { BotWalletCard } from "../components/BotWalletCard";
import { ProfitSettings } from "../components/ProfitSettings";
import { PositionsView } from "./PositionsView";

type DashboardViewProps = {
  botWallet: BotWallet;
  positions: Position[];
  takeProfit: number;
  draftTakeProfit: number;
  stopLoss: number;
  draftStopLoss: number;
  positionTimeoutMinutes: number;
  draftPositionTimeoutMinutes: number;
  buyAmountSol: number;
  draftBuyAmountSol: number;
  solPriceUsd: number;
  isWalletRefreshing: boolean;
  setDraftTakeProfit: (value: number) => void;
  setDraftStopLoss: (value: number) => void;
  setDraftPositionTimeoutMinutes: (value: number) => void;
  setDraftBuyAmountSol: (value: number) => void;
  onRefreshWallet: () => void;
  onSaveTakeProfit: () => void;
  onSellPosition: (id: string) => void;
};

export function DashboardView({
  botWallet,
  positions,
  takeProfit,
  draftTakeProfit,
  stopLoss,
  draftStopLoss,
  positionTimeoutMinutes,
  draftPositionTimeoutMinutes,
  buyAmountSol,
  draftBuyAmountSol,
  solPriceUsd,
  isWalletRefreshing,
  setDraftTakeProfit,
  setDraftStopLoss,
  setDraftPositionTimeoutMinutes,
  setDraftBuyAmountSol,
  onRefreshWallet,
  onSaveTakeProfit,
  onSellPosition
}: DashboardViewProps) {
  return (
    <>
      <BotWalletCard wallet={botWallet} isRefreshing={isWalletRefreshing} onRefresh={onRefreshWallet} />
      <ProfitSettings
        takeProfit={takeProfit}
        draftTakeProfit={draftTakeProfit}
        stopLoss={stopLoss}
        draftStopLoss={draftStopLoss}
        positionTimeoutMinutes={positionTimeoutMinutes}
        draftPositionTimeoutMinutes={draftPositionTimeoutMinutes}
        buyAmountSol={buyAmountSol}
        draftBuyAmountSol={draftBuyAmountSol}
        solPriceUsd={solPriceUsd}
        setDraftTakeProfit={setDraftTakeProfit}
        setDraftStopLoss={setDraftStopLoss}
        setDraftPositionTimeoutMinutes={setDraftPositionTimeoutMinutes}
        setDraftBuyAmountSol={setDraftBuyAmountSol}
        onSave={onSaveTakeProfit}
      />
      <PositionsView positions={positions} compact onSellPosition={onSellPosition} />
    </>
  );
}
