/**
 * In-memory cache of immutable per-mint metadata: token program owner +
 * decimals. Both are written once at mint creation and never change for the
 * lifetime of a mint, so we cache infinitely (per process).
 *
 * Replaces two per-buy RPCs:
 *   - getAccountInfo(mint) → owner (legacy SPL vs Token-2022)
 *   - getJupiterTokenDecimals(mint) (also getAccountInfo internally)
 *
 * Combined savings: ~150-230ms per buy on cache hit.
 *
 * LRU eviction caps memory: if we somehow accumulate 1000+ distinct mints in a
 * single worker process, the least-recently-used drops out. In practice we'll
 * never hit that — a busy copy-trader sees maybe 100 mints per day.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export type MintInfo = {
  /** Owner program: TOKEN_PROGRAM_ID (legacy SPL) or TOKEN_2022_PROGRAM_ID. */
  tokenProgram: PublicKey;
  /** UI decimals — needed for raw/ui amount conversion. */
  decimals: number;
};

const CACHE_LIMIT = 2000;
const cache = new Map<string, MintInfo>();

function touch(key: string, value: MintInfo) {
  // Map preserves insertion order; deleting then setting moves to "most recent"
  // for LRU semantics. Cap at CACHE_LIMIT entries — evict oldest on overflow.
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

/**
 * Read mint info, hitting RPC only on first lookup per mint.
 * Throws if the mint doesn't exist (callers can decide to treat as unrecoverable).
 */
export async function getMintInfo(connection: Connection, mint: PublicKey): Promise<MintInfo> {
  const key = mint.toBase58();
  const cached = cache.get(key);
  if (cached) {
    // Re-insert to bump LRU recency
    touch(key, cached);
    return cached;
  }

  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    throw new Error(`Mint ${key} not found on chain`);
  }
  const tokenProgram = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  // SPL Mint layout: decimals at byte 44 for both legacy and Token-2022 base layout
  const decimals = info.data[44];
  const result: MintInfo = { tokenProgram, decimals };
  touch(key, result);
  return result;
}

/** Test/maintenance helper — drop a mint from cache (e.g. after migration). */
export function invalidateMintInfo(mint: PublicKey | string): void {
  cache.delete(typeof mint === "string" ? mint : mint.toBase58());
}

/** Diagnostics helper for /api/health-style probes. */
export function getMintInfoCacheStats() {
  return { size: cache.size, limit: CACHE_LIMIT };
}
