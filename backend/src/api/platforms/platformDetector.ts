import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { PlatformName } from "../types";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

type TokenBalanceByMint = Map<string, number>;

type PlatformProgram = {
  platform: PlatformName;
  programIds: string[];
};

export type DetectedTraderBuy = {
  trader: string;
  signature: string;
  slot: number;
  blockTime: number | null | undefined;
  tokenMint: string;
  tokenAmount: number;
  solChange: number;
  wsolChange: number;
  spentSol: number;
  traderEntryPriceUsd: number;
  platform: PlatformName;
  matchedPrograms: string[];
};

const platformPrograms: PlatformProgram[] = [
  {
    platform: "Raydium",
    programIds: [
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
      "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
      "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS"
    ]
  },
  {
    platform: "Orca",
    programIds: ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"]
  },
  {
    platform: "Meteora",
    programIds: [
      "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
      "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
      "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
    ]
  },
  {
    platform: "Pump.fun",
    programIds: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
  },
  {
    platform: "PumpSwap",
    programIds: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"]
  }
];

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

function getTokenBalanceByMint(balances: any[] | null | undefined, owner: string, mint: string) {
  return (balances || [])
    .filter((balance) => balance.owner === owner && balance.mint === mint)
    .reduce((sum, balance) => sum + toTokenAmount(balance), 0);
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

function getWsolChangeForTrader(transaction: any, trader: string) {
  const pre = getTokenBalanceByMint(transaction.meta?.preTokenBalances, trader, WSOL_MINT);
  const post = getTokenBalanceByMint(transaction.meta?.postTokenBalances, trader, WSOL_MINT);
  return post - pre;
}

function getMentionedPrograms(transaction: any) {
  const keys = transaction.transaction.message.accountKeys || [];
  const mentioned = new Set<string>();

  for (const account of keys) {
    const pubkey = account.pubkey?.toBase58?.();
    if (pubkey) {
      mentioned.add(pubkey);
    }
  }

  return mentioned;
}

function detectPlatform(transaction: any) {
  const mentioned = getMentionedPrograms(transaction);

  for (const platform of platformPrograms) {
    const matchedPrograms = platform.programIds.filter((programId) => mentioned.has(programId));
    if (matchedPrograms.length > 0) {
      return {
        platform: platform.platform,
        matchedPrograms
      };
    }
  }

  return undefined;
}

export function detectTraderPlatformBuys(
  transaction: any,
  trader: string,
  signature: string,
  solPriceUsd: number
): DetectedTraderBuy[] {
  if (!transaction.meta) {
    return [];
  }

  const platformMatch = detectPlatform(transaction);
  if (!platformMatch) {
    return [];
  }

  const preBalances = collectTokenBalancesByMint(transaction.meta.preTokenBalances, trader);
  const postBalances = collectTokenBalancesByMint(transaction.meta.postTokenBalances, trader);
  const solChange = getSolChangeForTrader(transaction, trader);
  const wsolChange = getWsolChangeForTrader(transaction, trader);
  const spentSol = Math.max(0, -solChange, -wsolChange);

  if (spentSol <= 0.0005) {
    return [];
  }

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
      solChange,
      wsolChange,
      spentSol,
      traderEntryPriceUsd: solPriceUsd > 0 ? (spentSol * solPriceUsd) / delta : 0,
      platform: platformMatch.platform,
      matchedPrograms: platformMatch.matchedPrograms
    });
  }

  return buys;
}
