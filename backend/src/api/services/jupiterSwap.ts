import path from "path";
import fs from "fs/promises";
import dotenv from "dotenv";
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SPL_MINT_LAYOUT } from "@raydium-io/raydium-sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { createBotLog } from "./logs";
import { WSOL_MINT } from "../platforms/platformDetector";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

type SwapSide = "buy" | "sell";

export class JupiterRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "JupiterRequestError";
    this.status = status;
  }
}

export type JupiterSwapResult = {
  tokenMint: string;
  side: SwapSide;
  route: "Jupiter";
  signature?: string;
  tokenAmountDelta?: number;
  outputSol?: number;
  networkFeeSol?: number;
  priorityFeeSol?: number;
  quotedOutAmount?: number;
  quotedOutSol?: number;
  actualSolChange?: number;
};

export type JupiterQuote = {
  outAmount?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
};

const decimalsCache = new Map<string, number>();
const DEFAULT_SLIPPAGE_BPS = 200;
const DEFAULT_REQUEST_RETRIES = 1;
const DEFAULT_RATE_LIMIT_RETRY_MS = 60000;
const DEFAULT_REQUEST_INTERVAL_MS = 2500;
const RATE_LIMIT_LOCK_STALE_MS = 10000;
const BASE_SIGNATURE_FEE_LAMPORTS = 5000;
const rateLimitDir = path.resolve(__dirname, "../../../data");
const rateLimitStatePath = path.join(rateLimitDir, "jupiter-rate-limit.json");
const rateLimitLockPath = path.join(rateLimitDir, "jupiter-rate-limit.lock");

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJupiterRequestIntervalMs() {
  const value = Number(process.env.JUPITER_REQUEST_INTERVAL_MS);
  return Number.isFinite(value) && value >= 500 ? Math.floor(value) : DEFAULT_REQUEST_INTERVAL_MS;
}

function getJupiterRequestRetries() {
  const value = Number(process.env.JUPITER_REQUEST_RETRIES);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_REQUEST_RETRIES;
}

function getJupiterRateLimitRetryMs(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.ceil(retryAfterSeconds * 1000);
  }

  const value = Number(process.env.JUPITER_RATE_LIMIT_RETRY_MS);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : DEFAULT_RATE_LIMIT_RETRY_MS;
}

async function acquireJupiterRateLock() {
  await fs.mkdir(rateLimitDir, { recursive: true });

  while (true) {
    try {
      await fs.mkdir(rateLimitLockPath);
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const stats = await fs.stat(rateLimitLockPath).catch(() => undefined);
      if (stats && Date.now() - stats.mtimeMs > RATE_LIMIT_LOCK_STALE_MS) {
        await fs.rm(rateLimitLockPath, { recursive: true, force: true });
        continue;
      }

      await sleep(100);
    }
  }
}

async function releaseJupiterRateLock() {
  await fs.rm(rateLimitLockPath, { recursive: true, force: true }).catch(() => undefined);
}

async function waitForJupiterSlot() {
  const intervalMs = getJupiterRequestIntervalMs();

  await acquireJupiterRateLock();
  try {
    const rawState = await fs.readFile(rateLimitStatePath, "utf8").catch(() => "");
    const state = rawState ? (JSON.parse(rawState) as { nextAt?: number }) : {};
    const now = Date.now();
    const nextAt = Number.isFinite(state.nextAt) ? Number(state.nextAt) : now;
    const waitMs = Math.max(0, nextAt - now);
    const reservedAt = Math.max(now, nextAt) + intervalMs;

    await fs.writeFile(rateLimitStatePath, JSON.stringify({ nextAt: reservedAt }), "utf8");

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  } finally {
    await releaseJupiterRateLock();
  }
}

async function setJupiterCooldown(ms: number) {
  await acquireJupiterRateLock();
  try {
    const nextAt = Date.now() + ms;
    await fs.writeFile(rateLimitStatePath, JSON.stringify({ nextAt }), "utf8");
  } finally {
    await releaseJupiterRateLock();
  }
}

export function isJupiterRateLimitError(error: unknown) {
  return error instanceof JupiterRequestError && error.status === 429;
}

async function requestJson<T>(url: string, init?: RequestInit, retries = getJupiterRequestRetries()): Promise<T> {
  await waitForJupiterSlot();
  const response = await fetch(url, init);
  const payload: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 429 && retries > 0) {
      const retryMs = getJupiterRateLimitRetryMs(response);
      await setJupiterCooldown(retryMs);
      await sleep(retryMs);
      return requestJson<T>(url, init, retries - 1);
    }

    throw new JupiterRequestError(
      payload?.error || payload?.message || `Jupiter request failed: ${response.status}`,
      response.status
    );
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

async function getSwapExecutionCosts(input: {
  signature: string;
  wallet: PublicKey;
  signatureCount: number;
}) {
  const connection = getRaydiumConnection();
  let transaction: Awaited<ReturnType<typeof connection.getTransaction>> | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    transaction = await connection.getTransaction(input.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (transaction?.meta) {
      break;
    }

    await sleep(500);
  }

  const feeLamports = transaction?.meta?.fee;
  const networkFeeSol = typeof feeLamports === "number" ? feeLamports / LAMPORTS_PER_SOL : undefined;
  const baseFeeLamports = input.signatureCount * BASE_SIGNATURE_FEE_LAMPORTS;
  const priorityFeeSol =
    typeof feeLamports === "number" ? Math.max(0, feeLamports - baseFeeLamports) / LAMPORTS_PER_SOL : undefined;

  const message: any = transaction?.transaction.message;
  const accountKeys = message?.staticAccountKeys || message?.accountKeys || [];
  const walletIndex = accountKeys.findIndex((key: PublicKey) => key?.equals?.(input.wallet));
  const preLamports = walletIndex >= 0 ? transaction?.meta?.preBalances?.[walletIndex] : undefined;
  const postLamports = walletIndex >= 0 ? transaction?.meta?.postBalances?.[walletIndex] : undefined;
  const actualSolChange =
    typeof preLamports === "number" && typeof postLamports === "number"
      ? (postLamports - preLamports) / LAMPORTS_PER_SOL
      : undefined;

  return {
    networkFeeSol,
    priorityFeeSol,
    actualSolChange
  };
}

async function getTokenBalance(tokenMint: string) {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  const mint = new PublicKey(tokenMint);
  let total = 0;

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, "confirmed");
      for (const account of accounts.value) {
        const info = account.account.data.parsed?.info;
        if (info?.mint !== mint.toBase58()) {
          continue;
        }

        total += Number(info.tokenAmount?.uiAmount || 0);
      }
    } catch {
      continue;
    }
  }

  return total;
}

export async function getJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  logFailure?: boolean;
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
    if (params.logFailure !== false) {
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
    }
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
    const executionCosts = await getSwapExecutionCosts({
      signature,
      wallet: wallet.publicKey,
      signatureCount: transaction.signatures.length || 1
    });
    const after = await getTokenBalance(params.tokenMint);

    return {
      signature,
      tokenAmountDelta: params.side === "buy" ? Math.max(0, after - before) : Math.max(0, before - after),
      quoteResponse,
      executionCosts
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
  const { signature, tokenAmountDelta, quoteResponse, executionCosts } = await executeJupiterSwap({
    tokenMint,
    side: "buy",
    inputMint: WSOL_MINT,
    outputMint: tokenMint,
    rawAmount: toRawAmount(amountSol, 9)
  });
  const tokenDecimals = await getJupiterTokenDecimals(tokenMint).catch(() => undefined);

  return {
    tokenMint,
    side: "buy",
    route: "Jupiter",
    signature,
    tokenAmountDelta,
    quotedOutAmount: tokenDecimals === undefined ? tokenAmountDelta : rawToUiAmount(quoteResponse.outAmount, tokenDecimals),
    networkFeeSol: executionCosts.networkFeeSol,
    priorityFeeSol: executionCosts.priorityFeeSol,
    actualSolChange: executionCosts.actualSolChange
  };
}

export async function executeJupiterSell(tokenMint: string, tokenAmount: number): Promise<JupiterSwapResult> {
  const tokenDecimals = await getJupiterTokenDecimals(tokenMint);
  const { signature, tokenAmountDelta, quoteResponse, executionCosts } = await executeJupiterSwap({
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
    outputSol: rawToUiAmount(quoteResponse.outAmount, 9),
    quotedOutSol: rawToUiAmount(quoteResponse.outAmount, 9),
    networkFeeSol: executionCosts.networkFeeSol,
    priorityFeeSol: executionCosts.priorityFeeSol,
    actualSolChange: executionCosts.actualSolChange
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
    amount: toRawAmount(tokenAmount, tokenDecimals),
    logFailure: false
  });
  const outputSol = rawToUiAmount(quote.outAmount, 9);

  return (outputSol * solPriceUsd) / tokenAmount;
}
