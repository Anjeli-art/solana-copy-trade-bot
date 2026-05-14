import path from "path";
import dotenv from "dotenv";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SPL_MINT_LAYOUT } from "@raydium-io/raydium-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { createBotLog } from "./logs";
import { WSOL_MINT } from "../platforms/platformDetector";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

type SwapSide = "buy" | "sell";

export type JupiterSwapResult = {
  tokenMint: string;
  side: SwapSide;
  route: "Jupiter";
  signature?: string;
  tokenAmountDelta?: number;
  outputSol?: number;
};

export type JupiterQuote = {
  outAmount?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
};

const decimalsCache = new Map<string, number>();
const DEFAULT_SLIPPAGE_BPS = 500;

function getJupiterBaseUrl() {
  return (process.env.JUPITER_SWAP_API_URL || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
}

function getJupiterHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (process.env.JUPITER_API_KEY) {
    headers["x-api-key"] = process.env.JUPITER_API_KEY;
  }

  return headers;
}

function getSlippageBps() {
  const value = Number(process.env.JUPITER_SLIPPAGE_BPS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SLIPPAGE_BPS;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Jupiter request failed: ${response.status}`);
  }

  return payload as T;
}

export async function getJupiterTokenDecimals(tokenMint: string) {
  const cached = decimalsCache.get(tokenMint);
  if (cached !== undefined) {
    return cached;
  }

  const connection = getRaydiumConnection();
  const account = await connection.getAccountInfo(new PublicKey(tokenMint));
  if (!account) {
    throw new Error(`Token mint not found: ${tokenMint}`);
  }

  const decimals = SPL_MINT_LAYOUT.decode(account.data).decimals;
  decimalsCache.set(tokenMint, decimals);
  return decimals;
}

export function toRawAmount(amount: number, decimals: number) {
  return Math.max(1, Math.floor(amount * 10 ** decimals)).toString();
}

export function rawToUiAmount(rawAmount: string | undefined, decimals: number) {
  return Number(rawAmount || 0) / 10 ** decimals;
}

async function getTokenBalance(tokenMint: string) {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  const ata = getAssociatedTokenAddressSync(new PublicKey(tokenMint), wallet.publicKey);

  try {
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return balance.value.uiAmount || 0;
  } catch {
    return 0;
  }
}

export async function getJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}) {
  const url = new URL(`${getJupiterBaseUrl()}/quote`);
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", params.amount);
  url.searchParams.set("slippageBps", String(params.slippageBps || getSlippageBps()));
  url.searchParams.set("onlyDirectRoutes", "false");
  url.searchParams.set("asLegacyTransaction", "false");

  try {
    return await requestJson<JupiterQuote>(url.toString(), {
      headers: getJupiterHeaders()
    });
  } catch (error) {
    createBotLog({
      level: "error",
      event: "JUPITER_QUOTE_FAILED",
      message: getErrorMessage(error),
      tokenMint: params.outputMint === WSOL_MINT ? params.inputMint : params.outputMint,
      metadata: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: params.slippageBps || getSlippageBps()
      }
    });
    throw error;
  }
}

async function executeJupiterSwap(params: {
  tokenMint: string;
  side: SwapSide;
  inputMint: string;
  outputMint: string;
  rawAmount: string;
}) {
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const before = await getTokenBalance(params.tokenMint);
    const quoteResponse = await getJupiterQuote({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.rawAmount
    });
    const swapResponse: any = await requestJson(`${getJupiterBaseUrl()}/swap`, {
      method: "POST",
      headers: getJupiterHeaders(),
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto"
      })
    });

    if (!swapResponse?.swapTransaction) {
      throw new Error("Jupiter swap transaction was not returned");
    }

    const transaction = VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction, "base64"));
    transaction.sign([wallet]);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
    await connection.confirmTransaction(
      {
        signature,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: swapResponse.lastValidBlockHeight
      },
      "confirmed"
    );
    const after = await getTokenBalance(params.tokenMint);

    return {
      signature,
      tokenAmountDelta: params.side === "buy" ? Math.max(0, after - before) : Math.max(0, before - after),
      quoteResponse
    };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "JUPITER_SWAP_FAILED",
      message: getErrorMessage(error),
      tokenMint: params.tokenMint,
      metadata: {
        side: params.side,
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        rawAmount: params.rawAmount
      }
    });
    throw error;
  }
}

export async function executeJupiterBuy(tokenMint: string, amountSol: number): Promise<JupiterSwapResult> {
  const { signature, tokenAmountDelta } = await executeJupiterSwap({
    tokenMint,
    side: "buy",
    inputMint: WSOL_MINT,
    outputMint: tokenMint,
    rawAmount: toRawAmount(amountSol, 9)
  });

  return {
    tokenMint,
    side: "buy",
    route: "Jupiter",
    signature,
    tokenAmountDelta
  };
}

export async function executeJupiterSell(tokenMint: string, tokenAmount: number): Promise<JupiterSwapResult> {
  const tokenDecimals = await getJupiterTokenDecimals(tokenMint);
  const { signature, tokenAmountDelta, quoteResponse } = await executeJupiterSwap({
    tokenMint,
    side: "sell",
    inputMint: tokenMint,
    outputMint: WSOL_MINT,
    rawAmount: toRawAmount(tokenAmount, tokenDecimals)
  });

  return {
    tokenMint,
    side: "sell",
    route: "Jupiter",
    signature,
    tokenAmountDelta,
    outputSol: rawToUiAmount(quoteResponse.outAmount, 9)
  };
}

export async function getJupiterTokenPriceUsd(tokenMint: string, tokenAmount: number, solPriceUsd: number) {
  if (tokenAmount <= 0 || solPriceUsd <= 0) {
    return 0;
  }

  const tokenDecimals = await getJupiterTokenDecimals(tokenMint);
  const quote = await getJupiterQuote({
    inputMint: tokenMint,
    outputMint: WSOL_MINT,
    amount: toRawAmount(tokenAmount, tokenDecimals)
  });
  const outputSol = rawToUiAmount(quote.outAmount, 9);

  return (outputSol * solPriceUsd) / tokenAmount;
}
