/**
 * Raydium CLMM (Concentrated Liquidity Market Maker) pool helpers.
 *
 * Unlike standard AMMs, CLMM pools store the current price directly as `sqrtPriceX64`
 * inside the pool state account. We don't need to subscribe to vaults — one subscription
 * to the pool account is enough for real-time spot price.
 *
 * Conversion from sqrtPriceX64 to UI price:
 *   raw   = (sqrtPriceX64 / 2^64)^2
 *   ui    = raw * 10^(decimalsA - decimalsB)
 * That `ui` is "B per 1 A" in UI units. If A is the meme (base) and B is SOL (quote),
 * that's our SOL-per-token price. If A is SOL and B is the meme, invert.
 *
 * Quote calc for selling tokenAmount of base:
 *   solOut ≈ tokenAmount * price * (1 - feeBps/10000)
 * This is an approximation (concentrated liquidity has tick-based slippage), but it's
 * accurate enough for take-profit / stop-loss monitoring. The actual swap goes through
 * the Raydium SDK which honors true tick math.
 */
import { PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";

export type ClmmPoolDecoded = {
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  sqrtPriceX64: BN;
  liquidity: BN;
  observationId: string;
};

const TWO_POW_64 = new BN(2).pow(new BN(64));

export function decodeClmmPoolFromBase64(dataBase64: string): ClmmPoolDecoded {
  const buf = Buffer.from(dataBase64, "base64");
  const decoded = PoolInfoLayout.decode(buf);
  return {
    mintA: decoded.mintA.toBase58(),
    mintB: decoded.mintB.toBase58(),
    decimalsA: decoded.mintDecimalsA,
    decimalsB: decoded.mintDecimalsB,
    sqrtPriceX64: decoded.sqrtPriceX64,
    liquidity: decoded.liquidity,
    observationId: decoded.observationId.toBase58()
  };
}

/**
 * Compute spot price in SOL per 1 base token UI unit.
 * `tokenMint` is the meme we hold; we look at the pool to figure out whether the
 * meme is on side A or B and invert the formula accordingly.
 */
export function clmmSpotPriceSol(pool: ClmmPoolDecoded, tokenMint: string): number {
  const sqrtPrice = Number(pool.sqrtPriceX64.toString()) / Number(TWO_POW_64.toString());
  const rawPrice = sqrtPrice * sqrtPrice; // B per 1 A in raw u64 units

  if (pool.mintA === tokenMint) {
    // Base is A, quote is B (should be WSOL).
    // ui_price = raw * 10^(decimalsA - decimalsB) — gives SOL per 1 meme
    return rawPrice * Math.pow(10, pool.decimalsA - pool.decimalsB);
  }
  if (pool.mintB === tokenMint) {
    // Base is B, quote is A. Invert: raw is "B per 1 A" but we want "A per 1 B".
    if (rawPrice <= 0) return 0;
    const invertedRaw = 1 / rawPrice;
    return invertedRaw * Math.pow(10, pool.decimalsB - pool.decimalsA);
  }
  return 0;
}

/**
 * Approximate sell quote in SOL for given tokenAmount (UI units) using mid-price.
 * Ignores concentrated-liquidity tick boundaries; good enough for monitoring.
 * @param feeBps trading fee in basis points (varies per pool, typically 1/5/20/100)
 */
export function clmmSellQuoteSol(
  pool: ClmmPoolDecoded,
  tokenMint: string,
  tokenAmount: number,
  feeBps = 25
): number {
  if (tokenAmount <= 0) return 0;
  const price = clmmSpotPriceSol(pool, tokenMint);
  if (price <= 0) return 0;
  const feeMultiplier = (10000 - Math.max(0, Math.min(10000, Math.floor(feeBps)))) / 10000;
  return tokenAmount * price * feeMultiplier;
}
