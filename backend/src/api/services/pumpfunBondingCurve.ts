/**
 * Pump.fun bonding curve helpers.
 *
 * Pump.fun is a custom bonding curve (not a standard AMM). The curve account stores
 * `virtualTokenReserves` and `virtualQuoteReserves` (in lamports) directly, and the
 * price is computed via the standard constant-product formula adjusted for the
 * Pump.fun trading fee (1%).
 *
 * When a token "graduates" (bonding curve fills up), it migrates to PumpSwap and the
 * `complete` flag flips to true — we should stop subscribing at that point.
 *
 * Because the bonding curve account itself holds the reserves, we only need a single
 * accountSubscribe per Pump.fun position (vs PumpSwap which needs two vault subs).
 */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { PumpSdk } from "@pump-fun/pump-sdk";
import type { BondingCurve } from "@pump-fun/pump-sdk";

const offlineSdk = new PumpSdk();

/**
 * Decode a base64-encoded bonding curve account into the SDK's BondingCurve struct.
 * Throws if data is too short or malformed.
 */
export function decodeBondingCurveFromBase64(dataBase64: string): BondingCurve {
  const buf = Buffer.from(dataBase64, "base64");
  // The SDK wants an AccountInfo<Buffer> — we synthesize one with just the fields it reads.
  const accountInfo = {
    data: buf,
    executable: false,
    lamports: 0,
    owner: { equals: () => true } as unknown as import("@solana/web3.js").PublicKey,
    rentEpoch: 0
  };
  return offlineSdk.decodeBondingCurve(accountInfo as unknown as Parameters<typeof offlineSdk.decodeBondingCurve>[0]);
}

/**
 * Constant-product quote: given a sell amount of base token (raw u64), return the SOL
 * amount we'd receive (in raw lamports as bigint), accounting for the 1% Pump.fun fee.
 *
 * Pump.fun uses the same constant-product formula as a standard AMM, just with
 * virtual reserves stored directly in the curve account:
 *   out = virtual_quote * amount_in / (virtual_token + amount_in)
 * Then fees are deducted from the output.
 */
export function pumpFunSellSolFromTokens(
  virtualTokenReserves: BN,
  virtualQuoteReserves: BN,
  tokenAmountRaw: BN,
  feeBps = 100 // 1% trading fee
): bigint {
  if (tokenAmountRaw.lte(new BN(0))) return 0n;
  if (virtualTokenReserves.lte(new BN(0)) || virtualQuoteReserves.lte(new BN(0))) return 0n;

  const numerator = virtualQuoteReserves.mul(tokenAmountRaw);
  const denominator = virtualTokenReserves.add(tokenAmountRaw);
  const grossOut = numerator.div(denominator);
  const feeNumerator = new BN(10000 - Math.max(0, Math.min(10000, Math.floor(feeBps))));
  const netOut = grossOut.mul(feeNumerator).div(new BN(10000));
  return BigInt(netOut.toString());
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}
