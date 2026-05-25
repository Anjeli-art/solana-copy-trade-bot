import path from "path";
import dotenv from "dotenv";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readState } from "../state/store";
import { withRpcLimit } from "../utils/rpcLimiter";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_SIGNATURE_LIMIT = 20;
const MAX_SEEN_SIGNATURES_PER_TRADER = 500;

type TokenBalanceByMint = Map<string, number>;

type ParsedTokenBalance = {
  owner?: string;
  mint?: string;
  uiTokenAmount?: {
    uiAmount?: number | null;
    amount?: string;
    decimals?: number;
  };
};

type ParsedAccountKey = {
  pubkey?: {
    toBase58?: () => string;
  };
};

type ParsedMonitorTransaction = {
  slot: number;
  blockTime?: number | null;
  transaction: {
    message: {
      accountKeys?: ParsedAccountKey[];
    };
  };
  meta?: {
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: ParsedTokenBalance[] | null;
    postTokenBalances?: ParsedTokenBalance[] | null;
  } | null;
};

type DetectedTraderBuy = {
  trader: string;
  signature: string;
  slot: number;
  blockTime: number | null | undefined;
  tokenMint: string;
  tokenAmount: number;
  solChange: number;
};

function getRpcEndpoint() {
  return process.env.MAINNET_ENDPOINT || process.env.RPC_ENDPOINT || "";
}

function getPollIntervalMs() {
  const value = Number(process.env.FREE_MONITOR_POLL_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function getSignatureLimit() {
  const value = Number(process.env.FREE_MONITOR_SIGNATURE_LIMIT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SIGNATURE_LIMIT;
}

function shouldIncludeHistory() {
  return process.env.FREE_MONITOR_INCLUDE_HISTORY === "true";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toTokenAmount(balance: ParsedTokenBalance) {
  const amount = balance?.uiTokenAmount?.uiAmount;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return amount;
  }

  const rawAmount = Number(balance?.uiTokenAmount?.amount || 0);
  const decimals = Number(balance?.uiTokenAmount?.decimals || 0);
  return rawAmount / 10 ** decimals;
}

function collectTokenBalancesByMint(balances: ParsedTokenBalance[] | null | undefined, owner: string): TokenBalanceByMint {
  const byMint: TokenBalanceByMint = new Map();

  for (const balance of balances || []) {
    if (balance.owner !== owner || !balance.mint || balance.mint === WSOL_MINT) {
      continue;
    }

    byMint.set(balance.mint, (byMint.get(balance.mint) || 0) + toTokenAmount(balance));
  }

  return byMint;
}

function getSolChangeForTrader(transaction: ParsedMonitorTransaction, trader: string) {
  const keys = transaction.transaction.message.accountKeys || [];
  const accountIndex = keys.findIndex((account) => account.pubkey?.toBase58?.() === trader);

  if (accountIndex < 0) {
    return 0;
  }

  const pre = transaction.meta?.preBalances?.[accountIndex] || 0;
  const post = transaction.meta?.postBalances?.[accountIndex] || 0;
  return (post - pre) / LAMPORTS_PER_SOL;
}

function detectTraderBuys(transaction: ParsedMonitorTransaction, trader: string, signature: string): DetectedTraderBuy[] {
  if (!transaction.meta) {
    return [];
  }

  const preBalances = collectTokenBalancesByMint(transaction.meta.preTokenBalances, trader);
  const postBalances = collectTokenBalancesByMint(transaction.meta.postTokenBalances, trader);
  const solChange = getSolChangeForTrader(transaction, trader);
  const buys: DetectedTraderBuy[] = [];

  for (const [mint, postAmount] of postBalances) {
    const preAmount = preBalances.get(mint) || 0;
    const delta = postAmount - preAmount;

    if (delta <= 0) {
      continue;
    }

    buys.push({
      trader,
      signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      tokenMint: mint,
      tokenAmount: delta,
      solChange
    });
  }

  return buys;
}

async function processTraderSignatures(
  connection: Connection,
  trader: string,
  seenSignatures: Set<string>,
  lastSeenSignature?: string
) {
  const signatures = await withRpcLimit(() =>
    connection.getSignaturesForAddress(new PublicKey(trader), {
      limit: getSignatureLimit(),
      until: lastSeenSignature
    })
  );

  const newSignatures = signatures
    .reverse()
    .filter((s) => !seenSignatures.has(s.signature) && !s.err);

  for (const s of newSignatures) {
    seenSignatures.add(s.signature);
  }

  // Prune oldest entries to prevent unbounded memory growth
  if (seenSignatures.size > MAX_SEEN_SIGNATURES_PER_TRADER) {
    const toDelete = seenSignatures.size - MAX_SEEN_SIGNATURES_PER_TRADER;
    let deleted = 0;
    for (const sig of seenSignatures) {
      if (deleted >= toDelete) break;
      seenSignatures.delete(sig);
      deleted++;
    }
  }

  // Fetch all new transactions in parallel, rate-limited by RPC_MAX_CONCURRENT
  const transactions = await Promise.all(
    newSignatures.map((s) =>
      withRpcLimit(() =>
        connection.getParsedTransaction(s.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        })
      )
    )
  );

  for (let i = 0; i < newSignatures.length; i++) {
    const transaction = transactions[i];
    if (!transaction) continue;

    const buys = detectTraderBuys(transaction, trader, newSignatures[i].signature);
    for (const buy of buys) {
      console.log(
        JSON.stringify({
          event: "TRADER_BUY_DETECTED",
          ...buy
        })
      );
    }
  }

  return signatures[signatures.length - 1]?.signature || lastSeenSignature;
}

export async function startFreeRpcTraderMonitor() {
  const endpoint = getRpcEndpoint();
  if (!endpoint) {
    throw new Error("MAINNET_ENDPOINT or RPC_ENDPOINT is required for free RPC monitoring");
  }

  const connection = new Connection(endpoint, "confirmed");
  const pollIntervalMs = getPollIntervalMs();
  const includeHistory = shouldIncludeHistory();
  const lastSeenByTrader = new Map<string, string | undefined>();
  const seenSignaturesByTrader = new Map<string, Set<string>>();

  console.log(`Free RPC trader monitor started. Poll interval: ${pollIntervalMs}ms`);
  console.log(`Historical signatures on startup: ${includeHistory ? "enabled" : "skipped"}`);
  console.log("gRPC monitor stays disabled for now and can replace this adapter later.");

  while (true) {
    const state = await readState();
    const traders = state.trackedTraders.filter((trader) => trader.enabled);

    // Poll all traders in parallel — last trader no longer waits for all previous ones
    await Promise.allSettled(
      traders.map(async (trader) => {
        try {
          const seenSignatures = seenSignaturesByTrader.get(trader.address) || new Set<string>();
          seenSignaturesByTrader.set(trader.address, seenSignatures);

          if (!includeHistory && !lastSeenByTrader.has(trader.address)) {
            const latest = await withRpcLimit(() =>
              connection.getSignaturesForAddress(new PublicKey(trader.address), { limit: 1 })
            );
            lastSeenByTrader.set(trader.address, latest[0]?.signature);
            return;
          }

          const lastSeenSignature = await processTraderSignatures(
            connection,
            trader.address,
            seenSignatures,
            lastSeenByTrader.get(trader.address)
          );

          lastSeenByTrader.set(trader.address, lastSeenSignature);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "TRADER_MONITOR_ERROR",
              trader: trader.address,
              message: error instanceof Error ? error.message : "Unknown monitor error"
            })
          );
        }
      })
    );

    await sleep(pollIntervalMs);
  }
}

if (require.main === module) {
  process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({ event: "MONITOR_UNHANDLED_REJECTION", message: String(reason) }));
    process.exit(1);
  });

  startFreeRpcTraderMonitor().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
