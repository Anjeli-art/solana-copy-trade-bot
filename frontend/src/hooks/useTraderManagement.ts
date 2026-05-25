import { FormEvent, useCallback, useState } from "react";
import { addTrackedTrader, deleteTrackedTrader, patchTrackedTrader } from "../api/client";
import type { Trader } from "../types";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

type SetTraders = (traders: Trader[]) => void;

export function useTraderManagement(traders: Trader[], setTraders: SetTraders) {
  const [walletAddress, setWalletAddress] = useState("");
  const [error, setError] = useState("");

  const addTrader = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
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
    },
    [setTraders, traders, walletAddress]
  );

  const removeTrader = useCallback(
    async (address: string) => {
      try {
        const nextTraders = await deleteTrackedTrader(address);
        setTraders(nextTraders);
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : "Failed to remove wallet");
      }
    },
    [setTraders]
  );

  const toggleTrader = useCallback(
    async (address: string, enabled: boolean) => {
      try {
        const nextTraders = await patchTrackedTrader(address, { enabled });
        setTraders(nextTraders);
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : "Failed to update trader");
      }
    },
    [setTraders]
  );

  return {
    walletAddress,
    error,
    setWalletAddress,
    setError,
    addTrader,
    removeTrader,
    toggleTrader
  };
}
