/**
 * Cache for Pump.fun protocol-level state: global config + fee config.
 *
 * Both are PROCESS-wide singletons that change very rarely (only when the team
 * updates the protocol — usually announced in advance). Reading them on every
 * buy adds ~300ms (2 parallel RPCs + SDK overhead). With a 5min TTL we serve
 * cached values for 99.9% of buys.
 *
 * Failure mode: if the SDK errors mid-build (e.g. fee account changed and our
 * cached config is stale), caller can invoke `forceRefresh()` and retry the
 * build once. Cheap insurance.
 */
import type { OnlinePumpSdk } from "@pump-fun/pump-sdk";

type Cached<T> = { value: T; fetchedAt: number };

const TTL_MS = 5 * 60_000;

let globalCache: Cached<unknown> | null = null;
let feeConfigCache: Cached<unknown> | null = null;

// Concurrent calls during a cold cache should share one RPC, not stampede.
let globalInflight: Promise<unknown> | null = null;
let feeConfigInflight: Promise<unknown> | null = null;

function isFresh<T>(c: Cached<T> | null, now: number): c is Cached<T> {
  return c !== null && now - c.fetchedAt < TTL_MS;
}

export async function getPumpFunGlobal(sdk: OnlinePumpSdk): Promise<Awaited<ReturnType<OnlinePumpSdk["fetchGlobal"]>>> {
  const now = Date.now();
  if (isFresh(globalCache, now)) {
    return globalCache.value as Awaited<ReturnType<OnlinePumpSdk["fetchGlobal"]>>;
  }
  if (globalInflight) {
    return globalInflight as Promise<Awaited<ReturnType<OnlinePumpSdk["fetchGlobal"]>>>;
  }
  globalInflight = sdk.fetchGlobal().then((value) => {
    globalCache = { value, fetchedAt: Date.now() };
    globalInflight = null;
    return value;
  }).catch((error) => {
    globalInflight = null;
    throw error;
  });
  return globalInflight as Promise<Awaited<ReturnType<OnlinePumpSdk["fetchGlobal"]>>>;
}

export async function getPumpFunFeeConfig(sdk: OnlinePumpSdk): Promise<Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>>> {
  const now = Date.now();
  if (isFresh(feeConfigCache, now)) {
    return feeConfigCache.value as Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>>;
  }
  if (feeConfigInflight) {
    return feeConfigInflight as Promise<Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>>>;
  }
  feeConfigInflight = sdk.fetchFeeConfig().then((value) => {
    feeConfigCache = { value, fetchedAt: Date.now() };
    feeConfigInflight = null;
    return value;
  }).catch((error) => {
    feeConfigInflight = null;
    throw error;
  });
  return feeConfigInflight as Promise<Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>>>;
}

/**
 * Drop cached config. Use from a swap-error retry path so the next buy fetches
 * fresh values once before declaring the trade dead.
 */
export function invalidatePumpFunConfig(): void {
  globalCache = null;
  feeConfigCache = null;
}
