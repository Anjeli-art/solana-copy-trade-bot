/**
 * Orca Whirlpool pool helpers.
 *
 * Whirlpool stores the current spot price as sqrtPriceX64 directly in the pool account
 * (same model as Raydium CLMM). We subscribe to the pool account via WebSocket, decode
 * on each push, and compute price locally.
 *
 * The pool also stores tokenMintA / tokenMintB / decimalsA / decimalsB indirectly via
 * the mints. Whirlpool's `feeRate` is in hundredths of a basis point (1e-6 of value).
 *
 * Pricing formula:
 *   sqrt = sqrtPriceX64 / 2^64
 *   raw  = sqrt^2  (B-per-A in raw u64 units)
 *   ui   = raw * 10^(decimalsA - decimalsB)  ("B amount per 1 A" in UI units)
 *
 * We don't always know which side is the meme until we look at the position's mint.
 * If meme === mintA: price is "B (SOL) per 1 A (meme)" → direct.
 * If meme === mintB: invert.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ParsableWhirlpool } from "@orca-so/whirlpools-sdk";

export type WhirlpoolDecoded = {
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  sqrtPriceX64: BN;
  feeRate: number; // hundredths of a basis point — e.g. 3000 = 0.3%
};

const TWO_POW_64 = new BN(2).pow(new BN(64));

/**
 * Decode an Orca Whirlpool account from a base64-encoded WebSocket push.
 * Uses Orca's own ParsableWhirlpool helper for safety against layout changes.
 */
export function decodeWhirlpoolFromBase64(dataBase64: string, poolAddress: string): WhirlpoolDecoded {
  const buf = Buffer.from(dataBase64, "base64");
  const accountInfo = {
    data: buf,
    executable: false,
    lamports: 0,
    owner: new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"),
    rentEpoch: 0
  };
  const decoded = ParsableWhirlpool.parse(new PublicKey(poolAddress), accountInfo);
  if (!decoded) {
    throw new Error(`Failed to parse Whirlpool account ${poolAddress}`);
  }
  return {
    mintA: decoded.tokenMintA.toBase58(),
    mintB: decoded.tokenMintB.toBase58(),
    vaultA: decoded.tokenVaultA.toBase58(),
    vaultB: decoded.tokenVaultB.toBase58(),
    sqrtPriceX64: decoded.sqrtPrice,
    feeRate: decoded.feeRate
  };
}

/**
 * Spot price = SOL per 1 base meme token (UI units). Need pool decimals A/B from outside
 * since the layout doesn't store them — typically passed in from token metadata.
 */
export function whirlpoolSpotPriceSol(
  pool: WhirlpoolDecoded,
  tokenMint: string,
  decimalsA: number,
  decimalsB: number
): number {
  const sqrt = Number(pool.sqrtPriceX64.toString()) / Number(TWO_POW_64.toString());
  const rawPrice = sqrt * sqrt; // B per 1 A in raw units

  if (pool.mintA === tokenMint) {
    return rawPrice * Math.pow(10, decimalsA - decimalsB);
  }
  if (pool.mintB === tokenMint) {
    if (rawPrice <= 0) return 0;
    return (1 / rawPrice) * Math.pow(10, decimalsB - decimalsA);
  }
  return 0;
}

/**
 * Approximate sell quote in SOL using the mid-price (ignores tick boundaries).
 * Whirlpool feeRate is "hundredths of a bp" — divide by 1,000,000 to get fraction.
 */
export function whirlpoolSellQuoteSol(
  pool: WhirlpoolDecoded,
  tokenMint: string,
  tokenAmount: number,
  decimalsA: number,
  decimalsB: number
): number {
  if (tokenAmount <= 0) return 0;
  const price = whirlpoolSpotPriceSol(pool, tokenMint, decimalsA, decimalsB);
  if (price <= 0) return 0;
  const feeFraction = Math.max(0, Math.min(1, pool.feeRate / 1_000_000));
  return tokenAmount * price * (1 - feeFraction);
}
