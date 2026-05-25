/**
 * Shared RPC concurrency limiter.
 *
 * Helius free tier: 10 req/sec.
 * With parallel trader polling + parallel tx fetching, bursts easily exceed
 * this limit. This limiter caps how many RPC calls are in-flight at once so
 * the burst stays within the plan's limit regardless of how many traders or
 * positions are being checked in parallel.
 *
 * Configure via RPC_MAX_CONCURRENT (default 5).
 * - Free tier (10 req/sec):    RPC_MAX_CONCURRENT=3
 * - Developer (50 req/sec):    RPC_MAX_CONCURRENT=15
 * - Business (200 req/sec):    RPC_MAX_CONCURRENT=50
 */

function getMaxConcurrent(): number {
  const value = Number(process.env.RPC_MAX_CONCURRENT);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3;
}

let running = 0;
const queue: Array<() => void> = [];

export async function withRpcLimit<T>(fn: () => Promise<T>): Promise<T> {
  const max = getMaxConcurrent();

  if (running >= max) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }

  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = queue.shift();
    if (next) next();
  }
}
