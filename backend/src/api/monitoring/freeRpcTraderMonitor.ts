import path from "path";
import dotenv from "dotenv";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readState } from "../state/store";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_SIGNATURE_LIMIT = 20;

type TokenBalanceByMint = Map<string, number>;

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

function toTokenAmount(balance: any) {
  const amount = balance?.uiTokenAmount?.uiAmount;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return amount;
  }

  const rawAmount = Number(balance?.uiTokenAmount?.amount || 0);
  const decimals = Number(balance?.uiTokenAmount?.decimals || 0);
  return rawAmount / 10 ** decimals;
}

function collectTokenBalancesByMint(balances: any[] | null | undefined, owner: string): TokenBalanceByMint {
  const byMint: TokenBalanceByMint = new Map();

  for (const balance of balances || []) {
    if (balance.owner !== owner || !balance.mint || balance.mint === WSOL_MINT) {
      continue;
    }

    byMint.set(balance.mint, (byMint.get(balance.mint) || 0) + toTokenAmount(balance));
  }

  return byMint;
}

function getSolChangeForTrader(transaction: any, trader: string) {
  const keys = transaction.transaction.message.accountKeys || [];
  const accountIndex = keys.findIndex((account: any) => account.pubkey?.toBase58?.() === trader);

  if (accountIndex < 0) {
    return 0;
  }

  const pre = transaction.meta?.preBalances?.[accountIndex] || 0;
  const post = transaction.meta?.postBalances?.[accountIndex] || 0;
  return (post - pre) / LAMPORTS_PER_SOL;
}

function detectTraderBuys(transaction: any, trader: string, signature: string): DetectedTraderBuy[] {
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
  const signatures = await connection.getSignaturesForAddress(new PublicKey(trader), {
    limit: getSignatureLimit(),
    until: lastSeenSignature
  });

  for (const signatureInfo of signatures.reverse()) {
    if (seenSignatures.has(signatureInfo.signature)) {
      continue;
    }

    seenSignatures.add(signatureInfo.signature);

    if (signatureInfo.err) {
      continue;
    }

    const transaction = await connection.getParsedTransaction(signatureInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!transaction) {
      continue;
    }

    const buys = detectTraderBuys(transaction, trader, signatureInfo.signature);
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

    for (const trader of traders) {
      try {
        const seenSignatures = seenSignaturesByTrader.get(trader.address) || new Set<string>();
        seenSignaturesByTrader.set(trader.address, seenSignatures);

        if (!includeHistory && !lastSeenByTrader.has(trader.address)) {
          const latest = await connection.getSignaturesForAddress(new PublicKey(trader.address), { limit: 1 });
          lastSeenByTrader.set(trader.address, latest[0]?.signature);
          continue;
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
    }

    await sleep(pollIntervalMs);
  }
}

if (require.main === module) {
  startFreeRpcTraderMonitor().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
