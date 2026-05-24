import { useEffect, useState } from "react";
import { formatSol, formatUsd } from "../utils/format";

type ProfitSettingsProps = {
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
  setDraftTakeProfit: (value: number) => void;
  setDraftHighTakeProfit: (value: number) => void;
  setDraftStopLoss: (value: number) => void;
  setDraftPositionTimeoutMinutes: (value: number) => void;
  setDraftBuyAmountSol: (value: number) => void;
  onSave: () => void;
};

function parseDecimalInput(value: string) {
  const normalizedValue = value.replace(",", ".");
  const nextValue = Number(normalizedValue);
  return Number.isFinite(nextValue) ? nextValue : null;
}

function formatInputValue(value: number) {
  return String(value).replace(".", ",");
}

export function ProfitSettings({
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
  setDraftTakeProfit,
  setDraftHighTakeProfit,
  setDraftStopLoss,
  setDraftPositionTimeoutMinutes,
  setDraftBuyAmountSol,
  onSave
}: ProfitSettingsProps) {
  const [takeProfitInput, setTakeProfitInput] = useState(() => formatInputValue(draftTakeProfit));
  const [highTakeProfitInput, setHighTakeProfitInput] = useState(() => formatInputValue(draftHighTakeProfit));
  const [stopLossInput, setStopLossInput] = useState(() => formatInputValue(draftStopLoss));
  const [timeoutInput, setTimeoutInput] = useState(() => formatInputValue(draftPositionTimeoutMinutes));
  const [buyAmountInput, setBuyAmountInput] = useState(() => formatInputValue(draftBuyAmountSol));
  const [activeInput, setActiveInput] = useState<"takeProfit" | "highTakeProfit" | "stopLoss" | "timeout" | "buyAmount" | null>(null);
  const hasChanges =
    Math.abs(takeProfit - draftTakeProfit) > 0.0001 ||
    Math.abs(highTakeProfit - draftHighTakeProfit) > 0.0001 ||
    Math.abs(stopLoss - draftStopLoss) > 0.0001 ||
    Math.abs(positionTimeoutMinutes - draftPositionTimeoutMinutes) > 0.0001 ||
    Math.abs(buyAmountSol - draftBuyAmountSol) > 0.0000001;
  const estimatedUsd = solPriceUsd > 0 ? draftBuyAmountSol * solPriceUsd : null;
  const estimatedUsdLabel = estimatedUsd === null ? "--" : formatUsd(estimatedUsd);

  useEffect(() => {
    if (activeInput !== "takeProfit") {
      setTakeProfitInput(formatInputValue(draftTakeProfit));
    }
  }, [activeInput, draftTakeProfit]);

  useEffect(() => {
    if (activeInput !== "highTakeProfit") {
      setHighTakeProfitInput(formatInputValue(draftHighTakeProfit));
    }
  }, [activeInput, draftHighTakeProfit]);

  useEffect(() => {
    if (activeInput !== "stopLoss") {
      setStopLossInput(formatInputValue(draftStopLoss));
    }
  }, [activeInput, draftStopLoss]);

  useEffect(() => {
    if (activeInput !== "buyAmount") {
      setBuyAmountInput(formatInputValue(draftBuyAmountSol));
    }
  }, [activeInput, draftBuyAmountSol]);

  useEffect(() => {
    if (activeInput !== "timeout") {
      setTimeoutInput(formatInputValue(draftPositionTimeoutMinutes));
    }
  }, [activeInput, draftPositionTimeoutMinutes]);

  function handleDecimalChange(
    value: string,
    setValue: (value: string) => void,
    commitValue: (value: number) => void,
    clampValue: (value: number) => number
  ) {
    setValue(value);

    if (!value || value === "," || value === "." || value.endsWith(",") || value.endsWith(".")) {
      return;
    }

    const nextValue = parseDecimalInput(value);
    if (nextValue !== null) {
      commitValue(clampValue(nextValue));
    }
  }

  function commitDecimalInput(
    value: string,
    fallback: number,
    setValue: (value: string) => void,
    commitValue: (value: number) => void,
    clampValue: (value: number) => number
  ) {
    const nextValue = parseDecimalInput(value);
    if (nextValue === null) {
      setValue(formatInputValue(fallback));
      return;
    }

    const clampedValue = clampValue(nextValue);
    commitValue(clampedValue);
    setValue(formatInputValue(clampedValue));
  }

  return (
    <section className="settings-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">Trading rules</p>
          <h2>Copy settings</h2>
        </div>
        <div className="setting-cluster">
          <div className={`save-state ${hasChanges ? "pending" : "saved"}`}>
            {hasChanges ? "Unsaved" : "Saved"}
          </div>
          <div className="setting-value">{takeProfit.toFixed(2)}x</div>
          <div className="setting-value">{highTakeProfit.toFixed(2)}x</div>
          <div className="setting-value stop-loss-value">{stopLoss > 0 ? `${stopLoss.toFixed(2)}x` : "Off"}</div>
          <div className="setting-value timeout-value">
            {positionTimeoutMinutes > 0 ? `${positionTimeoutMinutes}m` : "No timeout"}
          </div>
          <div className="setting-value">{formatSol(buyAmountSol)} SOL</div>
        </div>
      </div>
      <div className="profit-control">
        <label className="number-wrap">
          <span>Low profit</span>
          <input
            inputMode="decimal"
            value={takeProfitInput}
            onBlur={() => {
              commitDecimalInput(takeProfitInput, draftTakeProfit, setTakeProfitInput, setDraftTakeProfit, (value) =>
                Math.max(1.01, value)
              );
              setActiveInput(null);
            }}
            onFocus={() => setActiveInput("takeProfit")}
            onChange={(event) =>
              handleDecimalChange(event.target.value, setTakeProfitInput, setDraftTakeProfit, (value) =>
                Math.max(1.01, value)
              )
            }
          />
        </label>
        <label className="number-wrap">
          <span>High profit</span>
          <input
            inputMode="decimal"
            value={highTakeProfitInput}
            onBlur={() => {
              commitDecimalInput(
                highTakeProfitInput,
                draftHighTakeProfit,
                setHighTakeProfitInput,
                setDraftHighTakeProfit,
                (value) => Math.max(1.01, value)
              );
              setActiveInput(null);
            }}
            onFocus={() => setActiveInput("highTakeProfit")}
            onChange={(event) =>
              handleDecimalChange(event.target.value, setHighTakeProfitInput, setDraftHighTakeProfit, (value) =>
                Math.max(1.01, value)
              )
            }
          />
        </label>
        <label className="number-wrap">
          <span>Stop loss</span>
          <input
            inputMode="decimal"
            value={stopLossInput}
            onBlur={() => {
              commitDecimalInput(stopLossInput, draftStopLoss, setStopLossInput, setDraftStopLoss, (value) =>
                Math.min(0.99, Math.max(0, value))
              );
              setActiveInput(null);
            }}
            onFocus={() => setActiveInput("stopLoss")}
            onChange={(event) =>
              handleDecimalChange(event.target.value, setStopLossInput, setDraftStopLoss, (value) =>
                Math.min(0.99, Math.max(0, value))
              )
            }
          />
        </label>
        <label className="number-wrap">
          <span>Timeout min</span>
          <input
            inputMode="decimal"
            value={timeoutInput}
            onBlur={() => {
              commitDecimalInput(
                timeoutInput,
                draftPositionTimeoutMinutes,
                setTimeoutInput,
                setDraftPositionTimeoutMinutes,
                (value) => Math.max(0, Math.round(value))
              );
              setActiveInput(null);
            }}
            onFocus={() => setActiveInput("timeout")}
            onChange={(event) =>
              handleDecimalChange(event.target.value, setTimeoutInput, setDraftPositionTimeoutMinutes, (value) =>
                Math.max(0, Math.round(value))
              )
            }
          />
        </label>
        <label className="number-wrap">
          <span className="inline-label">
            Buy amount
            <b title="Converted with Jupiter Price API SOL/USD">{estimatedUsdLabel}</b>
          </span>
          <input
            inputMode="decimal"
            value={buyAmountInput}
            onBlur={() => {
              commitDecimalInput(buyAmountInput, draftBuyAmountSol, setBuyAmountInput, setDraftBuyAmountSol, (value) =>
                Math.max(0.001, value)
              );
              setActiveInput(null);
            }}
            onFocus={() => setActiveInput("buyAmount")}
            onChange={(event) =>
              handleDecimalChange(event.target.value, setBuyAmountInput, setDraftBuyAmountSol, (value) =>
                Math.max(0.001, value)
              )
            }
          />
        </label>
        <div className="save-control">
          <span>Settings</span>
          <button className="save-button" type="button" disabled={!hasChanges} onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </section>
  );
}
