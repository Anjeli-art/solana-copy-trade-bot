import path from "path";
import dotenv from "dotenv";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BOT_WALLET_ADDRESS } from "../constants";
import { createBotLog } from "./logs";
import type { BotWalletSnapshot } from "../types";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_PRICE_ENDPOINT = "https://lite-api.jup.ag/price/v3";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

function getRpcEndpoint() {
  return process.env.MAINNET_ENDPOINT || process.env.RPC_ENDPOINT || "";
}

async function fetchSolPriceUsd(currentPrice: number) {
  try {
    const endpoint = process.env.JUPITER_PRICE_ENDPOINT || JUPITER_PRICE_ENDPOINT;
    const response = await fetch(`${endpoint}?ids=${SOL_MINT}`);

    if (!response.ok) {
      return currentPrice;
    }

    const priceResponse = (await response.json()) as Record<string, { usdPrice?: number }>;
    const price = priceResponse[SOL_MINT]?.usdPrice;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : currentPrice;
  } catch {
    return currentPrice;
  }
}

export async function refreshWalletBalance(wallet: BotWalletSnapshot): Promise<BotWalletSnapshot> {
  const address = wallet.address || BOT_WALLET_ADDRESS;
  const endpoint = getRpcEndpoint();
  const solPriceUsd = await fetchSolPriceUsd(wallet.solPriceUsd);

  if (!endpoint) {
    return {
      ...wallet,
      address,
      solPriceUsd,
      lastUpdated: new Date().toISOString()
    };
  }

  const connection = new Connection(endpoint, "confirmed");
  let lamports: number;
  try {
    lamports = await connection.getBalance(new PublicKey(address), "confirmed");
  } catch (error) {
    createBotLog({
      level: "error",
      event: "RPC_REQUEST_FAILED",
      message: error instanceof Error ? error.message : "Unknown RPC request error",
      wallet: address,
      metadata: {
        method: "getBalance",
        endpoint,
        address
      }
    });
    throw error;
  }

  return {
    ...wallet,
    address,
    solBalance: lamports / LAMPORTS_PER_SOL,
    solPriceUsd,
    lastUpdated: new Date().toISOString()
  };
}
