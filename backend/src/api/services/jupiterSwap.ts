import path from "path";
import fs from "fs/promises";
import dotenv from "dotenv";
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { SPL_MINT_LAYOUT } from "@raydium-io/raydium-sdk";
import { getRaydiumConnection, getTradingWallet } from "./raydiumSwap";
import { createBotLog } from "./logs";
import { WSOL_MINT } from "../platforms/platformDetector";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

type SwapSide = "buy" | "sell";

type SwapExecutionDetails = {
  networkFeeSol?: number;
  priorityFeeSol?: number;
  actualSolChange?: number;
  tokenDelta: number;
  blockTime?: number | null;
};

type NodeFsError = Error & {
  code?: string;
};

type JupiterErrorPayload = {
  error?: string;
  message?: string;
};

type SwapTransactionResponse = {
  swapTransaction?: string;
  lastValidBlockHeight: number;
};

type VersionedMessageWithKeys = VersionedTransaction["message"] & {
  accountKeys?: PublicKey[];
  staticAccountKeys?: PublicKey[];
};

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
    } catch (error) {
      if ((error as NodeFsError)?.code !== "EEXIST") {
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
  const payload = await response.json().catch(() => ({})) as JupiterErrorPayload;

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

function rawBigIntToUiAmount(rawAmount: bigint, decimals: number) {
  return Number(rawAmount) / 10 ** decimals;
}

async function getSwapExecutionDetails(input: {
  signature: string;
  wallet: PublicKey;
  tokenMint: string;
  signatureCount: number;
}): Promise<SwapExecutionDetails> {
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

  if (!transaction?.meta) {
    throw new Error(`Confirmed transaction meta was not available for ${input.signature}`);
  }

  const feeLamports = transaction?.meta?.fee;
  const networkFeeSol = typeof feeLamports === "number" ? feeLamports / LAMPORTS_PER_SOL : undefined;
  const baseFeeLamports = input.signatureCount * BASE_SIGNATURE_FEE_LAMPORTS;
  const priorityFeeSol =
    typeof feeLamports === "number" ? Math.max(0, feeLamports - baseFeeLamports) / LAMPORTS_PER_SOL : undefined;

  const message = transaction.transaction.message as VersionedMessageWithKeys;
  const accountKeys = message?.staticAccountKeys || message?.accountKeys || [];
  const walletIndex = accountKeys.findIndex((key: PublicKey) => key?.equals?.(input.wallet));
  const preLamports = walletIndex >= 0 ? transaction?.meta?.preBalances?.[walletIndex] : undefined;
  const postLamports = walletIndex >= 0 ? transaction?.meta?.postBalances?.[walletIndex] : undefined;
  const actualSolChange =
    typeof preLamports === "number" && typeof postLamports === "number"
      ? (postLamports - preLamports) / LAMPORTS_PER_SOL
      : undefined;

  // Read token delta from transaction meta — exact for this specific tx, immune to concurrent buys
  const walletAddress = input.wallet.toBase58();
  const preTB = (transaction?.meta?.preTokenBalances ?? []) as Array<{
    accountIndex: number;
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
  }>;
  const postTB = (transaction?.meta?.postTokenBalances ?? []) as typeof preTB;

  const hasOwner = [...preTB, ...postTB].some((b) => b.owner !== undefined);
  const forWallet = (list: typeof preTB) =>
    list.filter((b) => b.mint === input.tokenMint && (!hasOwner || b.owner === walletAddress));

  const balancesForMint = [...forWallet(preTB), ...forWallet(postTB)];
  const tokenDecimals = balancesForMint[0]?.uiTokenAmount.decimals ?? 0;
  const sumRaw = (list: typeof preTB) =>
    forWallet(list).reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount || "0"), 0n);
  const tokenDeltaRaw = sumRaw(postTB) - sumRaw(preTB);
  const tokenDelta = rawBigIntToUiAmount(tokenDeltaRaw, tokenDecimals);

  return {
    networkFeeSol,
    priorityFeeSol,
    actualSolChange,
    tokenDelta,
    blockTime: transaction.blockTime
  };
}

export async function getJupiterSwapExecutionDetails(input: {
  signature: string;
  tokenMint: string;
  signatureCount?: number;
}) {
  const wallet = getTradingWallet();
  return getSwapExecutionDetails({
    signature: input.signature,
    wallet: wallet.publicKey,
    tokenMint: input.tokenMint,
    signatureCount: input.signatureCount || 1
  });
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
  preQuoteResponse?: JupiterQuote;
  shouldSend?: () => boolean | Promise<boolean>;
  onSignature?: (signature: string) => void | Promise<void>;
}) {
  try {
    const connection = getRaydiumConnection();
    const wallet = getTradingWallet();
    const quoteResponse = params.preQuoteResponse ?? await getJupiterQuote({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.rawAmount
    });
    const swapResponse = await requestJson<SwapTransactionResponse>(`${getJupiterBaseUrl()}/swap`, {
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
    if (params.shouldSend && !(await params.shouldSend())) {
      throw new Error("Swap aborted before send: trading was stopped");
    }
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
    await params.onSignature?.(signature);
    await connection.confirmTransaction(
      {
        signature,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: swapResponse.lastValidBlockHeight
      },
      "confirmed"
    );

    // Read execution details from the confirmed transaction (fees + token delta from tx meta,
    // not from separate balance calls — prevents contamination by concurrent buys).
    const executionDetails = await getSwapExecutionDetails({
      signature,
      wallet: wallet.publicKey,
      tokenMint: params.tokenMint,
      signatureCount: transaction.signatures.length || 1
    });

    const tokenAmountDelta = Math.abs(executionDetails.tokenDelta);

    return {
      signature,
      tokenAmountDelta,
      quoteResponse,
      executionCosts: {
        networkFeeSol: executionDetails.networkFeeSol,
        priorityFeeSol: executionDetails.priorityFeeSol,
        actualSolChange: executionDetails.actualSolChange
      }
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

export async function executeJupiterBuy(
  tokenMint: string,
  amountSol: number,
  options: {
    shouldSend?: () => boolean | Promise<boolean>;
    onSignature?: (signature: string) => void | Promise<void>;
  } = {}
): Promise<JupiterSwapResult> {
  const { signature, tokenAmountDelta, quoteResponse, executionCosts } = await executeJupiterSwap({
    tokenMint,
    side: "buy",
    inputMint: WSOL_MINT,
    outputMint: tokenMint,
    rawAmount: toRawAmount(amountSol, 9),
    shouldSend: options.shouldSend,
    onSignature: options.onSignature
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

export async function executeJupiterSell(
  tokenMint: string,
  tokenAmount: number,
  preQuoteResponse?: JupiterQuote
): Promise<JupiterSwapResult> {
  const tokenDecimals = await getJupiterTokenDecimals(tokenMint);
  const { signature, tokenAmountDelta, quoteResponse, executionCosts } = await executeJupiterSwap({
    tokenMint,
    side: "sell",
    inputMint: tokenMint,
    outputMint: WSOL_MINT,
    rawAmount: toRawAmount(tokenAmount, tokenDecimals),
    preQuoteResponse
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

export async function getJupiterSellQuote(
  tokenMint: string,
  tokenAmount: number
): Promise<{ quotedOutSol: number; quoteResponse: JupiterQuote }> {
  if (tokenAmount <= 0) {
    return { quotedOutSol: 0, quoteResponse: {} };
  }

  const tokenDecimals = await getJupiterTokenDecimals(tokenMint);
  const quoteResponse = await getJupiterQuote({
    inputMint: tokenMint,
    outputMint: WSOL_MINT,
    amount: toRawAmount(tokenAmount, tokenDecimals),
    logFailure: false
  });

  return { quotedOutSol: rawToUiAmount(quoteResponse.outAmount, 9), quoteResponse };
}

export async function getJupiterSellQuoteSol(tokenMint: string, tokenAmount: number) {
  const { quotedOutSol } = await getJupiterSellQuote(tokenMint, tokenAmount);
  return quotedOutSol;
}

export async function getJupiterTokenPriceUsd(tokenMint: string, tokenAmount: number, solPriceUsd: number) {
  if (tokenAmount <= 0 || solPriceUsd <= 0) {
    return 0;
  }

  const outputSol = await getJupiterSellQuoteSol(tokenMint, tokenAmount);

  return (outputSol * solPriceUsd) / tokenAmount;
}
