import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import type { PlatformName } from "../types";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

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

type ParsedPlatformTransaction = {
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
  // Pool/curve info for native monitoring. Populated when extractor matched a known
  // venue. Null when the trader used Jupiter routing or layout didn't match — in
  // that case price monitoring falls back to Jupiter polling.
  poolAddress?: string;
  poolBaseVault?: string;
  poolQuoteVault?: string;
  // Subtype hint so the worker can pick the right SDK at buy time and the right
  // WebSocket decoder for price monitoring. Stays in sync with ActivePosition.monitorType.
  monitorType?:
    | "pumpswap"
    | "pumpfun"
    | "raydium_amm_v4"
    | "raydium_cpmm"
    | "raydium_clmm"
    | "orca_whirlpool"
    | null;
};

export const PUMP_SWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const RAYDIUM_AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

type ParsedInstruction = {
  programId?: { toBase58?: () => string };
  program?: string;
  accounts?: Array<{ toBase58?: () => string }>;
  parsed?: unknown;
};

type ParsedTransactionWithInner = ParsedPlatformTransaction & {
  transaction: {
    message: {
      accountKeys?: ParsedAccountKey[];
      instructions?: ParsedInstruction[];
    };
  };
  meta?: ParsedPlatformTransaction["meta"] & {
    innerInstructions?: Array<{ instructions?: ParsedInstruction[] }> | null;
  };
};

/**
 * Find the PumpSwap instruction in the transaction (outer or inner) and pull pool
 * addresses out of its account list. PumpSwap is anchor-based; account ordering is
 * deterministic:
 *   accounts[0] = pool PDA
 *   accounts[7] = pool base token vault (holds the meme token)
 *   accounts[8] = pool quote token vault (holds WSOL)
 *
 * Returns null when no PumpSwap instruction was found or the account list is too
 * short — in that case the position will fall back to Jupiter polling for price.
 */
export function extractPumpSwapPoolInfo(transaction: ParsedPlatformTransaction): {
  poolAddress: string;
  poolBaseVault: string;
  poolQuoteVault: string;
} | null {
  const tx = transaction as ParsedTransactionWithInner;
  const allInstructions: ParsedInstruction[] = [];
  if (tx.transaction.message.instructions) {
    allInstructions.push(...tx.transaction.message.instructions);
  }
  for (const inner of tx.meta?.innerInstructions || []) {
    if (inner.instructions) {
      allInstructions.push(...inner.instructions);
    }
  }

  for (const ix of allInstructions) {
    const programId = ix.programId?.toBase58?.();
    if (programId !== PUMP_SWAP_PROGRAM_ID) continue;
    const accounts = ix.accounts || [];
    if (accounts.length < 9) continue;
    const poolAddress = accounts[0]?.toBase58?.();
    const poolBaseVault = accounts[7]?.toBase58?.();
    const poolQuoteVault = accounts[8]?.toBase58?.();
    if (poolAddress && poolBaseVault && poolQuoteVault) {
      return { poolAddress, poolBaseVault, poolQuoteVault };
    }
  }

  return null;
}

/**
 * Find a Raydium AMM v4 swap instruction in the transaction (outer or inner) and pull
 * pool / base vault / quote vault out of the account list. Raydium AMM v4 has a fixed
 * canonical account ordering for `swap` and `swapBaseIn` instructions:
 *
 *   accounts[1] = ammId (pool state PDA)
 *   accounts[5] = poolCoinTokenAccount  (base vault)
 *   accounts[6] = poolPcTokenAccount    (quote vault)
 *
 * Only triggers on the direct AMM v4 program — not the Raydium Route program — because
 * routed swaps have a different layout we can't safely guess from indices.
 *
 * Returns null when no matching instruction is found; in that case the position falls
 * back to Jupiter polling for price.
 */
export function extractRaydiumAmmV4PoolInfo(transaction: ParsedPlatformTransaction): {
  poolAddress: string;
  poolBaseVault: string;
  poolQuoteVault: string;
} | null {
  const tx = transaction as ParsedTransactionWithInner;
  const allInstructions: ParsedInstruction[] = [];
  if (tx.transaction.message.instructions) {
    allInstructions.push(...tx.transaction.message.instructions);
  }
  for (const inner of tx.meta?.innerInstructions || []) {
    if (inner.instructions) {
      allInstructions.push(...inner.instructions);
    }
  }

  for (const ix of allInstructions) {
    const programId = ix.programId?.toBase58?.();
    if (programId !== RAYDIUM_AMM_V4_PROGRAM_ID) continue;
    const accounts = ix.accounts || [];
    // Layout sanity: swap instructions reference at least 17 accounts. Guard against
    // unexpected sub-calls (initialize, deposit) which won't match this shape.
    if (accounts.length < 17) continue;
    const poolAddress = accounts[1]?.toBase58?.();
    const poolBaseVault = accounts[5]?.toBase58?.();
    const poolQuoteVault = accounts[6]?.toBase58?.();
    if (poolAddress && poolBaseVault && poolQuoteVault) {
      return { poolAddress, poolBaseVault, poolQuoteVault };
    }
  }

  return null;
}

/**
 * Find a Raydium CPMM swap instruction and pull pool + base/quote vaults.
 * CPMM swap layout (accounts):
 *   [3] pool state
 *   [6] inputVault, [7] outputVault — these are pool token vaults whose
 *       base/quote role depends on swap direction. We resolve which is which
 *       by looking at the transaction's token balances: whichever vault holds
 *       `tokenMint` (the meme) is the base vault, whichever holds WSOL is quote.
 */
export function extractRaydiumCpmmPoolInfo(
  transaction: ParsedPlatformTransaction,
  tokenMint: string
): {
  poolAddress: string;
  poolBaseVault: string;
  poolQuoteVault: string;
} | null {
  const tx = transaction as ParsedTransactionWithInner;
  const allInstructions: ParsedInstruction[] = [];
  if (tx.transaction.message.instructions) {
    allInstructions.push(...tx.transaction.message.instructions);
  }
  for (const inner of tx.meta?.innerInstructions || []) {
    if (inner.instructions) {
      allInstructions.push(...inner.instructions);
    }
  }

  for (const ix of allInstructions) {
    const programId = ix.programId?.toBase58?.();
    if (programId !== RAYDIUM_CPMM_PROGRAM_ID) continue;
    const accounts = ix.accounts || [];
    if (accounts.length < 13) continue;
    const poolAddress = accounts[3]?.toBase58?.();
    const vaultA = accounts[6]?.toBase58?.();
    const vaultB = accounts[7]?.toBase58?.();
    if (!poolAddress || !vaultA || !vaultB) continue;

    // Resolve base/quote via post token balances: match each vault's mint.
    const postBalances = tx.meta?.postTokenBalances || [];
    const accountKeys = tx.transaction.message.accountKeys || [];
    const vaultMint = (vault: string): string | null => {
      const idx = accountKeys.findIndex((a) => a.pubkey?.toBase58?.() === vault);
      if (idx < 0) return null;
      const balance = postBalances.find((b) => (b as unknown as { accountIndex?: number }).accountIndex === idx);
      return (balance as ParsedTokenBalance)?.mint || null;
    };
    const mintA = vaultMint(vaultA);
    const mintB = vaultMint(vaultB);
    let baseVault: string | null = null;
    let quoteVault: string | null = null;
    if (mintA === tokenMint && mintB === WSOL_MINT) {
      baseVault = vaultA;
      quoteVault = vaultB;
    } else if (mintB === tokenMint && mintA === WSOL_MINT) {
      baseVault = vaultB;
      quoteVault = vaultA;
    } else {
      // Couldn't resolve cleanly — skip native monitoring, fall back to Jupiter.
      continue;
    }
    return { poolAddress, poolBaseVault: baseVault, poolQuoteVault: quoteVault };
  }

  return null;
}

/**
 * Find an Orca Whirlpool swap instruction and pull pool state address.
 * Whirlpool's `swap` instruction layout (from anchor IDL):
 *   accounts[0] = token program
 *   accounts[1] = token authority (user)
 *   accounts[2] = pool (whirlpool state)
 *   accounts[3] = user token A account
 *   accounts[4] = pool token vault A
 *   accounts[5] = user token B account
 *   accounts[6] = pool token vault B
 *   accounts[7-9] = tick arrays
 *   accounts[10] = oracle
 *
 * Pricing comes from sqrtPrice in the pool account itself, same as Raydium CLMM —
 * no vault subscription needed.
 */
export function extractOrcaWhirlpoolPoolInfo(transaction: ParsedPlatformTransaction): {
  poolAddress: string;
} | null {
  const tx = transaction as ParsedTransactionWithInner;
  const allInstructions: ParsedInstruction[] = [];
  if (tx.transaction.message.instructions) {
    allInstructions.push(...tx.transaction.message.instructions);
  }
  for (const inner of tx.meta?.innerInstructions || []) {
    if (inner.instructions) {
      allInstructions.push(...inner.instructions);
    }
  }

  for (const ix of allInstructions) {
    const programId = ix.programId?.toBase58?.();
    if (programId !== ORCA_WHIRLPOOL_PROGRAM_ID) continue;
    const accounts = ix.accounts || [];
    // Whirlpool swap requires at least 11 accounts (pool through oracle).
    if (accounts.length < 11) continue;
    const poolAddress = accounts[2]?.toBase58?.();
    if (poolAddress) return { poolAddress };
  }

  return null;
}

/**
 * Find a Raydium CLMM swap instruction and pull pool state address.
 * Layout: accounts[3] is the pool state account. CLMM pricing comes from sqrtPriceX64
 * stored directly in the pool account — we don't need vault subscriptions.
 */
export function extractRaydiumClmmPoolInfo(transaction: ParsedPlatformTransaction): {
  poolAddress: string;
} | null {
  const tx = transaction as ParsedTransactionWithInner;
  const allInstructions: ParsedInstruction[] = [];
  if (tx.transaction.message.instructions) {
    allInstructions.push(...tx.transaction.message.instructions);
  }
  for (const inner of tx.meta?.innerInstructions || []) {
    if (inner.instructions) {
      allInstructions.push(...inner.instructions);
    }
  }

  for (const ix of allInstructions) {
    const programId = ix.programId?.toBase58?.();
    if (programId !== RAYDIUM_CLMM_PROGRAM_ID) continue;
    const accounts = ix.accounts || [];
    if (accounts.length < 12) continue;
    const poolAddress = accounts[3]?.toBase58?.();
    if (poolAddress) return { poolAddress };
  }

  return null;
}

/**
 * Derive the Pump.fun bonding curve PDA for a given token mint.
 * Pump.fun's bonding curve is fully deterministic from the mint, so no transaction parsing
 * is needed. The bonding curve account holds reserves directly (virtualTokenReserves,
 * virtualQuoteReserves) — that's what we subscribe to for real-time price.
 */
export function derivePumpFunBondingCurve(tokenMint: string): string | null {
  try {
    const pda = bondingCurvePda(new PublicKey(tokenMint));
    return pda.toBase58();
  } catch {
    return null;
  }
}

export type UnmatchedTraderBuyLike = {
  trader: string;
  signature: string;
  slot: number;
  blockTime: number | null | undefined;
  tokenMint: string;
  tokenAmount: number;
  solChange: number;
  wsolChange: number;
  spentSol: number;
  mentionedPrograms: string[];
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
      "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
      "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
    ]
  },
  {
    platform: "Pump.fun",
    programIds: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
  },
  {
    platform: "PumpSwap",
    programIds: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"]
  },
  {
    platform: "Jupiter",
    programIds: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]
  }
];

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

function getTokenBalanceByMint(balances: ParsedTokenBalance[] | null | undefined, owner: string, mint: string) {
  return (balances || [])
    .filter((balance) => balance.owner === owner && balance.mint === mint)
    .reduce((sum, balance) => sum + toTokenAmount(balance), 0);
}

function getSolChangeForTrader(transaction: ParsedPlatformTransaction, trader: string) {
  const keys = transaction.transaction.message.accountKeys || [];
  const accountIndex = keys.findIndex((account) => account.pubkey?.toBase58?.() === trader);

  if (accountIndex < 0) {
    return 0;
  }

  const pre = transaction.meta?.preBalances?.[accountIndex] || 0;
  const post = transaction.meta?.postBalances?.[accountIndex] || 0;
  return (post - pre) / LAMPORTS_PER_SOL;
}

function getWsolChangeForTrader(transaction: ParsedPlatformTransaction, trader: string) {
  const pre = getTokenBalanceByMint(transaction.meta?.preTokenBalances, trader, WSOL_MINT);
  const post = getTokenBalanceByMint(transaction.meta?.postTokenBalances, trader, WSOL_MINT);
  return post - pre;
}

function getMentionedPrograms(transaction: ParsedPlatformTransaction) {
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

function getKnownPlatformProgramIds() {
  return new Set(platformPrograms.flatMap((platform) => platform.programIds));
}

function detectPlatform(transaction: ParsedPlatformTransaction) {
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

function getTraderBuyDeltas(transaction: ParsedPlatformTransaction, trader: string) {
  if (!transaction.meta) {
    return [];
  }

  const preBalances = collectTokenBalancesByMint(transaction.meta.preTokenBalances, trader);
  const postBalances = collectTokenBalancesByMint(transaction.meta.postTokenBalances, trader);
  const deltas: Array<{ mint: string; delta: number }> = [];

  for (const [mint, postAmount] of postBalances) {
    const preAmount = preBalances.get(mint) || 0;
    const delta = postAmount - preAmount;

    if (delta > 0) {
      deltas.push({ mint, delta });
    }
  }

  return deltas;
}

export function detectTraderPlatformBuys(
  transaction: ParsedPlatformTransaction,
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

  const solChange = getSolChangeForTrader(transaction, trader);
  const wsolChange = getWsolChangeForTrader(transaction, trader);
  const spentSol = Math.max(0, -solChange, -wsolChange);

  if (spentSol <= 0.0005) {
    return [];
  }

  const buys: DetectedTraderBuy[] = [];
  // Extract pool info once per transaction. Native monitoring is only enabled for
  // platforms whose extractor returns non-null, otherwise the position falls back
  // to Jupiter polling for price.
  const pumpSwapPool =
    platformMatch.platform === "PumpSwap" ? extractPumpSwapPoolInfo(transaction) : null;
  const raydiumAmmPool =
    platformMatch.platform === "Raydium" ? extractRaydiumAmmV4PoolInfo(transaction) : null;
  const raydiumClmmPool =
    platformMatch.platform === "Raydium" ? extractRaydiumClmmPoolInfo(transaction) : null;
  const orcaWhirlpool =
    platformMatch.platform === "Orca" ? extractOrcaWhirlpoolPoolInfo(transaction) : null;

  for (const { mint, delta } of getTraderBuyDeltas(transaction, trader)) {
    // For Pump.fun bonding curve, derive the curve PDA per-token (deterministic from mint).
    const pumpFunBondingCurve =
      platformMatch.platform === "Pump.fun" ? derivePumpFunBondingCurve(mint) : null;
    // CPMM resolution depends on the meme mint per-buy (base/quote disambiguation).
    const raydiumCpmmPool =
      platformMatch.platform === "Raydium"
        ? extractRaydiumCpmmPoolInfo(transaction, mint)
        : null;
    // Resolve subtype: most-specific match wins. Required so the worker can route
    // to the correct native SDK (AMM v4 vs CPMM vs CLMM all carry platform="Raydium").
    let monitorType: DetectedTraderBuy["monitorType"] = null;
    if (pumpSwapPool) monitorType = "pumpswap";
    else if (raydiumAmmPool) monitorType = "raydium_amm_v4";
    else if (raydiumCpmmPool) monitorType = "raydium_cpmm";
    else if (raydiumClmmPool) monitorType = "raydium_clmm";
    else if (orcaWhirlpool) monitorType = "orca_whirlpool";
    else if (pumpFunBondingCurve) monitorType = "pumpfun";
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
      matchedPrograms: platformMatch.matchedPrograms,
      poolAddress:
        pumpSwapPool?.poolAddress ||
        raydiumAmmPool?.poolAddress ||
        raydiumCpmmPool?.poolAddress ||
        raydiumClmmPool?.poolAddress ||
        orcaWhirlpool?.poolAddress ||
        pumpFunBondingCurve ||
        undefined,
      poolBaseVault:
        pumpSwapPool?.poolBaseVault ||
        raydiumAmmPool?.poolBaseVault ||
        raydiumCpmmPool?.poolBaseVault,
      poolQuoteVault:
        pumpSwapPool?.poolQuoteVault ||
        raydiumAmmPool?.poolQuoteVault ||
        raydiumCpmmPool?.poolQuoteVault,
      monitorType
    });
  }

  return buys;
}

export type DetectedTraderSell = {
  trader: string;
  signature: string;
  slot: number;
  blockTime: number | null | undefined;
  tokenMint: string;
  tokenAmountSold: number;
  sellPct: number;
  solReceived: number;
  platform: PlatformName;
  matchedPrograms: string[];
};

function getTraderSellDeltas(transaction: ParsedPlatformTransaction, trader: string) {
  if (!transaction.meta) {
    return [];
  }

  const preBalances = collectTokenBalancesByMint(transaction.meta.preTokenBalances, trader);
  const postBalances = collectTokenBalancesByMint(transaction.meta.postTokenBalances, trader);
  const deltas: Array<{ mint: string; amountSold: number; preBalance: number }> = [];

  for (const [mint, preAmount] of preBalances) {
    const postAmount = postBalances.get(mint) || 0;
    const sold = preAmount - postAmount;
    if (sold > 0) {
      deltas.push({ mint, amountSold: sold, preBalance: preAmount });
    }
  }

  return deltas;
}

export function detectTraderPlatformSells(
  transaction: ParsedPlatformTransaction,
  trader: string,
  signature: string
): DetectedTraderSell[] {
  if (!transaction.meta) {
    return [];
  }

  const platformMatch = detectPlatform(transaction);
  if (!platformMatch) {
    return [];
  }

  const solChange = getSolChangeForTrader(transaction, trader);
  const wsolChange = getWsolChangeForTrader(transaction, trader);
  // Positive = received SOL (sell direction)
  const solReceived = Math.max(0, solChange, wsolChange);

  if (solReceived <= 0.0001) {
    return [];
  }

  const sells: DetectedTraderSell[] = [];

  for (const { mint, amountSold, preBalance } of getTraderSellDeltas(transaction, trader)) {
    const sellPct = preBalance > 0 ? Math.min(1, amountSold / preBalance) : 1;
    sells.push({
      trader,
      signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      tokenMint: mint,
      tokenAmountSold: amountSold,
      sellPct,
      solReceived,
      platform: platformMatch.platform,
      matchedPrograms: platformMatch.matchedPrograms
    });
  }

  return sells;
}

export function detectUnmatchedTraderBuyLikes(
  transaction: ParsedPlatformTransaction,
  trader: string,
  signature: string
): UnmatchedTraderBuyLike[] {
  if (!transaction.meta || detectPlatform(transaction)) {
    return [];
  }

  const solChange = getSolChangeForTrader(transaction, trader);
  const wsolChange = getWsolChangeForTrader(transaction, trader);
  const spentSol = Math.max(0, -solChange, -wsolChange);

  if (spentSol <= 0.0005) {
    return [];
  }

  const knownPlatformProgramIds = getKnownPlatformProgramIds();
  const mentionedPrograms = Array.from(getMentionedPrograms(transaction)).filter(
    (programId) => !knownPlatformProgramIds.has(programId)
  );

  return getTraderBuyDeltas(transaction, trader).map(({ mint, delta }) => ({
    trader,
    signature,
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    tokenMint: mint,
    tokenAmount: delta,
    solChange,
    wsolChange,
    spentSol,
    mentionedPrograms
  }));
}
