import path from "path";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "../db/sqlite";
import { detectTraderPlatformBuys, type DetectedTraderBuy } from "../platforms/platformDetector";
import { executeJupiterBuy } from "../services/jupiterSwap";
import { createBotLog } from "../services/logs";
import { logTokenSafetyBeforeBuy } from "../services/tokenSafety";
import { getTokenMetadata } from "../services/tokenMetadata";
import { refreshWalletBalance } from "../services/walletBalance";
import { addActivePosition, readState } from "../state/store";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_SIGNATURE_LIMIT = 20;
const FEE_RESERVE_SOL = 0.01;

function getRpcEndpoint() {
  return process.env.MAINNET_ENDPOINT || process.env.RPC_ENDPOINT || "";
}

function getPollIntervalMs() {
  const value = Number(process.env.COPY_TRADE_POLL_MS || process.env.FREE_MONITOR_POLL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function getSignatureLimit() {
  const value = Number(process.env.COPY_TRADE_SIGNATURE_LIMIT || process.env.FREE_MONITOR_SIGNATURE_LIMIT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SIGNATURE_LIMIT;
}

function shouldIncludeHistory() {
  return process.env.COPY_TRADE_INCLUDE_HISTORY === "true";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown RPC request error";
}

function logRpcRequestFailed(input: {
  method: string;
  trader: string;
  signature?: string;
  endpoint?: string;
  error: unknown;
}) {
  createBotLog({
    level: "error",
    event: "RPC_REQUEST_FAILED",
    message: getErrorMessage(input.error),
    wallet: input.trader,
    trader: input.trader,
    signature: input.signature,
    metadata: {
      method: input.method,
      endpoint: input.endpoint,
      signature: input.signature
    }
  });
}

function isProcessed(signature: string) {
  const row = db.prepare("SELECT signature FROM processed_signatures WHERE signature = ?").get(signature);
  return Boolean(row);
}

function markProcessed(input: {
  signature: string;
  trader: string;
  tokenMint?: string;
  status: "dry-run" | "success" | "failed" | "skipped";
  message?: string;
}) {
  db.prepare(
    `
      INSERT INTO processed_signatures (signature, trader, token_mint, action, status, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET
        token_mint = excluded.token_mint,
        status = excluded.status,
        message = excluded.message
    `
  ).run(input.signature, input.trader, input.tokenMint || null, "copy-buy", input.status, input.message || null, now());
}

async function handleDetectedBuy(buy: DetectedTraderBuy) {
  if (isProcessed(buy.signature)) {
    return;
  }

  const state = await readState();
  const amountSol = state.settings.buyAmountSol;
  const existingPosition = state.activePositions.find((position) => position.tokenMint === buy.tokenMint);

  if (existingPosition) {
    const message = `Buy skipped: active position already exists for ${buy.tokenMint}`;
    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "skipped",
      message
    });
    createBotLog({
      level: "warn",
      event: "BUY_SKIPPED_POSITION_EXISTS",
      message,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      positionId: existingPosition.id,
      metadata: {
        existingPositionId: existingPosition.id,
        existingPositionTrader: existingPosition.sourceTrader,
        traderSpentSol: buy.spentSol,
        platform: buy.platform
      }
    });
    return;
  }

  try {
    const wallet = await refreshWalletBalance(state.wallet);
    if (wallet.solBalance < amountSol + FEE_RESERVE_SOL) {
      const message = `Buy skipped: wallet balance ${wallet.solBalance.toFixed(6)} SOL is below required ${(amountSol + FEE_RESERVE_SOL).toFixed(6)} SOL`;
      markProcessed({
        signature: buy.signature,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        status: "skipped",
        message
      });
      createBotLog({
        level: "warn",
        event: "BUY_SKIPPED_INSUFFICIENT_SOL",
        message,
        trader: buy.trader,
        tokenMint: buy.tokenMint,
        signature: buy.signature,
        metadata: {
          solBalance: wallet.solBalance,
          buyAmountSol: amountSol,
          feeReserveSol: FEE_RESERVE_SOL
        }
      });
      return;
    }

    createBotLog({
      event: "TRADER_BUY_DETECTED",
      message: `Tracked trader bought ${buy.tokenMint} on ${buy.platform}`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      metadata: {
        traderSpentSol: buy.spentSol,
        traderEntryPriceUsd: buy.traderEntryPriceUsd,
        copiedAmountSol: amountSol,
        platform: buy.platform,
        matchedPrograms: buy.matchedPrograms
      }
    });

    await logTokenSafetyBeforeBuy({
      tokenMint: buy.tokenMint,
      amountSol,
      trader: buy.trader,
      signature: buy.signature,
      source: "copy-trade"
    });

    const result = await executeJupiterBuy(buy.tokenMint, amountSol);
    const tokenAmount = result.tokenAmountDelta || 0;
    const amountUsd = amountSol * wallet.solPriceUsd;
    const entryPriceUsd = tokenAmount > 0 && amountUsd > 0 ? amountUsd / tokenAmount : 0;
    const tokenMetadata = await getTokenMetadata(buy.tokenMint).catch(() => undefined);

    await addActivePosition(
      {
        id: randomUUID(),
        tokenSymbol: tokenMetadata?.symbol || buy.tokenMint.slice(0, 6),
        tokenMint: buy.tokenMint,
        tokenImage: tokenMetadata?.image,
        sourceTrader: buy.trader,
        buyPlatform: buy.platform,
        buyTx: result.signature,
        entryPriceUsd,
        currentPriceUsd: entryPriceUsd,
        amountUsd,
        solSpent: amountSol,
        tokenAmount,
        openedAt: new Date().toISOString(),
        status: "open"
      },
      wallet
    );

    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "success",
      message: result.signature
    });
    createBotLog({
      event: "COPY_BUY_EXECUTED",
      message: `Copied ${buy.platform} buy through Jupiter for ${amountSol} SOL`,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: result.signature,
      metadata: {
        sourceSignature: buy.signature,
        tokenAmount,
        entryPriceUsd,
        sourcePlatform: buy.platform,
        executionRoute: "Jupiter"
      }
    });
    console.log(
      JSON.stringify({
        event: "COPY_TRADE_BUY_EXECUTED",
        trader: buy.trader,
        sourceSignature: buy.signature,
        tokenMint: buy.tokenMint,
        amountSol,
        botSignature: result.signature,
        tokenAmount,
        platform: buy.platform,
        executionRoute: "Jupiter",
        traderSpentSol: buy.spentSol,
        traderEntryPriceUsd: buy.traderEntryPriceUsd
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown copy trade error";
    markProcessed({
      signature: buy.signature,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      status: "failed",
      message
    });
    createBotLog({
      level: "error",
      event: "COPY_BUY_FAILED",
      message,
      trader: buy.trader,
      tokenMint: buy.tokenMint,
      signature: buy.signature,
      metadata: {
        traderSpentSol: buy.spentSol
      }
    });
    console.error(
      JSON.stringify({
        event: "COPY_TRADE_BUY_FAILED",
        trader: buy.trader,
        signature: buy.signature,
        tokenMint: buy.tokenMint,
        traderSpentSol: buy.spentSol,
        message
      })
    );
  }
}

async function processTraderSignatures(
  connection: Connection,
  trader: string,
  lastSeenSignature?: string
) {
  const state = await readState();
  const wallet = await refreshWalletBalance(state.wallet);
  let signatures;
  try {
    signatures = await connection.getSignaturesForAddress(new PublicKey(trader), {
      limit: getSignatureLimit(),
      until: lastSeenSignature
    });
  } catch (error) {
    logRpcRequestFailed({
      method: "getSignaturesForAddress",
      trader,
      endpoint: getRpcEndpoint(),
      error
    });
    throw error;
  }

  for (const signatureInfo of signatures.reverse()) {
    if (signatureInfo.err || isProcessed(signatureInfo.signature)) {
      continue;
    }

    let transaction;
    try {
      transaction = await connection.getParsedTransaction(signatureInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
    } catch (error) {
      logRpcRequestFailed({
        method: "getParsedTransaction",
        trader,
        signature: signatureInfo.signature,
        endpoint: getRpcEndpoint(),
        error
      });
      throw error;
    }

    if (!transaction) {
      continue;
    }

    const buys = detectTraderPlatformBuys(transaction, trader, signatureInfo.signature, wallet.solPriceUsd);
    for (const buy of buys) {
      await handleDetectedBuy(buy);
    }
  }

  return signatures[signatures.length - 1]?.signature || lastSeenSignature;
}

export async function startCopyTradeWorker() {
  const endpoint = getRpcEndpoint();
  if (!endpoint) {
    throw new Error("MAINNET_ENDPOINT or RPC_ENDPOINT is required for copy-trade worker");
  }

  const connection = new Connection(endpoint, "confirmed");
  const pollIntervalMs = getPollIntervalMs();
  const includeHistory = shouldIncludeHistory();
  const lastSeenByTrader = new Map<string, string | undefined>();

  console.log(`Copy-trade worker started. Poll interval: ${pollIntervalMs}ms`);
  console.log(`Historical signatures on startup: ${includeHistory ? "enabled" : "skipped"}`);
  console.log("Real multi-platform buy execution through Jupiter: enabled");

  while (true) {
    const state = await readState();
    const traders = state.trackedTraders.filter((trader) => trader.enabled);

    for (const trader of traders) {
      try {
        if (!includeHistory && !lastSeenByTrader.has(trader.address)) {
          let latest;
          try {
            latest = await connection.getSignaturesForAddress(new PublicKey(trader.address), { limit: 1 });
          } catch (error) {
            logRpcRequestFailed({
              method: "getSignaturesForAddress",
              trader: trader.address,
              endpoint,
              error
            });
            throw error;
          }
          lastSeenByTrader.set(trader.address, latest[0]?.signature);
          continue;
        }

        const lastSeenSignature = await processTraderSignatures(
          connection,
          trader.address,
          lastSeenByTrader.get(trader.address)
        );

        lastSeenByTrader.set(trader.address, lastSeenSignature);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "COPY_TRADE_WORKER_ERROR",
            trader: trader.address,
            message: error instanceof Error ? error.message : "Unknown worker error"
          })
        );
      }
    }

    await sleep(pollIntervalMs);
  }
}

if (require.main === module) {
  startCopyTradeWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
