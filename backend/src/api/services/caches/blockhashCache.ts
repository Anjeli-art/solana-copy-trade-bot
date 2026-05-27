/**
 * Background-refreshed cached blockhash.
 *
 * Solana blockhashes are valid for ~150 slots ≈ 60 seconds. We refresh every
 * 8s in the background so any tx builder reads a fresh one without paying
 * the ~80-100ms RPC roundtrip per build. The freshest possible blockhash also
 * minimizes "BlockhashNotFound" rejections on send.
 *
 * Failure modes:
 *   - Stale (refresh failed recently): cached value still valid for full TTL
 *     window since fetchedAt. If the cached one is too old, force a sync fetch.
 *   - Race on startup: first caller does a sync fetch and seeds the cache.
 *   - BlockhashNotFound on send: caller can invoke `forceRefresh()` and rebuild
 *     the tx once. Worth one extra round-trip to save a missed snipe.
 */
import type { Connection } from "@solana/web3.js";

type CachedBlockhash = {
  blockhash: string;
  lastValidBlockHeight: number;
  /** When the cached value was read from RPC (epoch ms). */
  fetchedAt: number;
};

// Safety: a blockhash window is ~60s. We treat anything older than 25s as
// suspect — force a sync refresh if asked, even though it's technically valid.
// Background refresh runs every 8s so the cache should stay <12s old in steady state.
const MAX_USABLE_AGE_MS = 25_000;
const BACKGROUND_INTERVAL_MS = 8_000;

let cached: CachedBlockhash | null = null;
let backgroundTimer: NodeJS.Timeout | null = null;
let lastConnection: Connection | null = null;

async function fetchAndStore(connection: Connection): Promise<CachedBlockhash> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  cached = { blockhash, lastValidBlockHeight, fetchedAt: Date.now() };
  return cached;
}

/**
 * Start the background refresh loop. Idempotent — safe to call multiple times.
 * Each worker process should call this once on startup.
 */
export function startBlockhashRefresh(connection: Connection): void {
  lastConnection = connection;
  if (backgroundTimer) return;
  // Prime the cache immediately so first caller doesn't pay RPC latency.
  fetchAndStore(connection).catch(() => {
    // First fetch failed — getCachedBlockhash will do a sync fetch on demand
  });
  backgroundTimer = setInterval(() => {
    if (!lastConnection) return;
    fetchAndStore(lastConnection).catch(() => {
      // Background refresh failure isn't fatal — cached value still valid in its TTL.
      // The next tick will retry.
    });
  }, BACKGROUND_INTERVAL_MS);
  backgroundTimer.unref?.();
}

/**
 * Get a fresh blockhash with no RPC roundtrip in the common case.
 * Falls back to a sync fetch if the cache is missing or too old.
 */
export async function getCachedBlockhash(
  connection: Connection
): Promise<Pick<CachedBlockhash, "blockhash" | "lastValidBlockHeight">> {
  // Ensure background loop is running (auto-start on first use if a caller
  // forgot to invoke startBlockhashRefresh explicitly).
  if (!backgroundTimer) startBlockhashRefresh(connection);

  const now = Date.now();
  if (cached && now - cached.fetchedAt < MAX_USABLE_AGE_MS) {
    return { blockhash: cached.blockhash, lastValidBlockHeight: cached.lastValidBlockHeight };
  }
  // Stale or absent — sync fetch.
  const fresh = await fetchAndStore(connection);
  return { blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight };
}

/**
 * Invoke from a send-error handler when the RPC says BlockhashNotFound. Returns
 * a fresh blockhash and updates the cache. Caller rebuilds the tx with this
 * and retries send.
 */
export async function forceBlockhashRefresh(
  connection: Connection
): Promise<Pick<CachedBlockhash, "blockhash" | "lastValidBlockHeight">> {
  const fresh = await fetchAndStore(connection);
  return { blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight };
}

/** Stop background refresh (called on worker shutdown). */
export function stopBlockhashRefresh(): void {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}
