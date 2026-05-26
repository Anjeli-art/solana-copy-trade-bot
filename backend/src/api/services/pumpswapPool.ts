/**
 * PumpSwap pool helpers.
 *
 * PumpSwap is a constant-product AMM ([x * y = k]). Each pool has two vault
 * accounts — one for the base token (the meme), one for the quote token (WSOL).
 * Reserves are just the SPL Token amount fields of those vaults.
 *
 * SPL Token v2 account layout (165 bytes):
 *   offset 0..32  mint            Pubkey
 *   offset 32..64 owner           Pubkey
 *   offset 64..72 amount          u64 little-endian
 *   offset 72..76 delegate option u32 (0 = none, 1 = some)
 *   offset 76..108 delegate       Pubkey (if delegated)
 *   offset 108    state           u8
 *   offset 109..113 is_native     u32 option tag
 *   offset 113..121 is_native     u64 (rent reserve if WSOL)
 *   offset 121..129 delegated     u64
 *   offset 129..161 close auth    Pubkey option
 *
 * We only need bytes 64..72 (amount). All numbers are little-endian.
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export const WSOL_DECIMALS = 9;

/**
 * Read the u64 `amount` field from an SPL Token account encoded as base64.
 * Returns the raw amount as a bigint (not adjusted for decimals).
 */
export function decodeTokenAccountAmount(dataBase64: string): bigint {
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length < 72) {
    throw new Error(`Token account data too short: ${buf.length} bytes`);
  }
  // u64 LE at offset 64
  return buf.readBigUInt64LE(64);
}

/**
 * Read the mint (Pubkey) field from an SPL Token account encoded as base64.
 * Useful for validating that a vault we subscribed to actually holds the token we expect.
 */
export function decodeTokenAccountMint(dataBase64: string): string {
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length < 32) {
    throw new Error(`Token account data too short: ${buf.length} bytes`);
  }
  // PublicKey is just 32 bytes; we re-export it as base58 via @solana/web3.js
  // but we want to avoid extra deps here. Encode manually with bs58 import lazy at call site.
  // Simpler: return hex; callers can compare to PublicKey.toBuffer().
  return buf.subarray(0, 32).toString("base64");
}

/**
 * Calculate spot price of `base` denominated in `quote` (e.g. SOL).
 *
 * @param baseReserveRaw  raw u64 amount of base token in the pool vault
 * @param quoteReserveRaw raw u64 amount of quote (WSOL) in the pool vault
 * @param baseDecimals    decimals of base token
 * @returns price in SOL per 1 base token (UI-adjusted), or 0 if either reserve is zero
 */
export function calculatePumpSwapPriceSol(
  baseReserveRaw: bigint,
  quoteReserveRaw: bigint,
  baseDecimals: number
): number {
  if (baseReserveRaw === 0n || quoteReserveRaw === 0n) return 0;
  // Convert raw u64s to UI floats. Use Number conversion; values fit comfortably
  // within Number's 2^53 precision for typical SPL token amounts (max ~1e18 raw).
  const baseUi = Number(baseReserveRaw) / 10 ** baseDecimals;
  const quoteUi = Number(quoteReserveRaw) / 10 ** WSOL_DECIMALS;
  if (baseUi <= 0) return 0;
  return quoteUi / baseUi;
}

/**
 * Constant-product quote: given input amount, return expected output amount.
 * Used for both buy quotes (SOL in → token out) and sell quotes (token in → SOL out).
 *
 * @param inputReserveRaw  current raw reserve on the input side
 * @param outputReserveRaw current raw reserve on the output side
 * @param inputAmountRaw   amount of input (raw u64)
 * @param feeBps           fee in basis points (e.g. 30 = 0.3%)
 * @returns raw output amount as bigint, after fees
 */
export function getConstantProductOutputRaw(
  inputReserveRaw: bigint,
  outputReserveRaw: bigint,
  inputAmountRaw: bigint,
  feeBps: number
): bigint {
  if (inputAmountRaw <= 0n || inputReserveRaw <= 0n || outputReserveRaw <= 0n) {
    return 0n;
  }
  // amount_in_after_fee = amount_in * (10000 - feeBps) / 10000
  const feeNumerator = 10000n - BigInt(Math.max(0, Math.min(10000, Math.floor(feeBps))));
  const amountInAfterFee = (inputAmountRaw * feeNumerator) / 10000n;
  // x * y = k  →  out = y - (x*y)/(x+inAfterFee)
  const numerator = amountInAfterFee * outputReserveRaw;
  const denominator = inputReserveRaw + amountInAfterFee;
  return numerator / denominator;
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}
