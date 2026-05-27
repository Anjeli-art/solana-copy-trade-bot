/**
 * One-shot on-chain price lookup for a position.
 *
 * Used by API endpoints (e.g. average-down) that need a current sell-quote for a
 * single position without spinning up a worker. Mirrors the same decode logic that
 * profitWatcher / mirrorTradeWorker use against their in-memory caches, but fetches
 * the pool/curve account fresh via RPC at call time.
 *
 * Returns `null` if the position has no native monitor type or the chain data
 * isn't usable (curve graduated, pool missing). Callers should fall back to
 * Jupiter in that case.
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { ActivePosition } from "../types";
import { getRaydiumConnection } from "./raydiumSwap";
import {
  decodeBondingCurveFromBase64,
  pumpFunSellSolFromTokens
} from "./pumpfunBondingCurve";
import {
  decodeClmmPoolFromBase64,
  clmmSellQuoteSol
} from "./raydiumClmmPool";
import {
  decodeWhirlpoolFromBase64,
  whirlpoolSellQuoteSol
} from "./orcaWhirlpoolPool";
import {
  decodeTokenAccountAmount,
  getConstantProductOutputRaw
} from "./pumpswapPool";

// Both ActivePosition and the DB row for mirror_positions expose the same monitor
// fields — keep the input as a structural subset so callers from either side work.
type PositionLike = Pick<
  ActivePosition,
  "tokenMint" | "tokenAmount" | "monitorType" | "poolAddress" | "poolBaseVault" | "poolQuoteVault" | "poolBaseDecimals"
>;

/**
 * Fetch live sell-quote in SOL for the given position by reading the relevant
 * pool/curve account from chain. Returns `null` if the position can't be quoted
 * natively (no monitor type, missing pool fields, graduated curve, RPC failure).
 */
export async function getPositionSellQuoteSolFromChain(
  pos: PositionLike,
  connectionOverride?: Connection
): Promise<number | null> {
  const connection = connectionOverride ?? getRaydiumConnection();
  if (!pos.monitorType) return null;

  try {
    if (pos.monitorType === "pumpfun") {
      if (!pos.poolAddress || pos.poolBaseDecimals == null) return null;
      const info = await connection.getAccountInfo(new PublicKey(pos.poolAddress), "confirmed");
      if (!info) return null;
      const curve = decodeBondingCurveFromBase64(info.data.toString("base64"));
      if (curve.complete) return null; // graduated → curve math doesn't apply
      const rawAmount = new BN(
        Math.max(0, Math.floor(pos.tokenAmount * 10 ** pos.poolBaseDecimals))
      );
      const outLamports = pumpFunSellSolFromTokens(
        curve.virtualTokenReserves,
        curve.virtualQuoteReserves,
        rawAmount,
        100 // 1% Pump.fun fee
      );
      return Number(outLamports) / LAMPORTS_PER_SOL;
    }

    if (pos.monitorType === "raydium_clmm") {
      if (!pos.poolAddress) return null;
      const info = await connection.getAccountInfo(new PublicKey(pos.poolAddress), "confirmed");
      if (!info) return null;
      const pool = decodeClmmPoolFromBase64(info.data.toString("base64"));
      return clmmSellQuoteSol(pool, pos.tokenMint, pos.tokenAmount, 25);
    }

    if (pos.monitorType === "orca_whirlpool") {
      if (!pos.poolAddress || pos.poolBaseDecimals == null) return null;
      const info = await connection.getAccountInfo(new PublicKey(pos.poolAddress), "confirmed");
      if (!info) return null;
      const pool = decodeWhirlpoolFromBase64(info.data.toString("base64"), pos.poolAddress);
      const memeIsA = pool.mintA === pos.tokenMint;
      const decimalsA = memeIsA ? pos.poolBaseDecimals : 9;
      const decimalsB = memeIsA ? 9 : pos.poolBaseDecimals;
      return whirlpoolSellQuoteSol(pool, pos.tokenMint, pos.tokenAmount, decimalsA, decimalsB);
    }

    // PumpSwap / Raydium AMM v4 / Raydium CPMM — constant product with two vaults.
    if (!pos.poolBaseVault || !pos.poolQuoteVault) return null;
    if (pos.poolBaseDecimals == null) return null;
    const [baseInfo, quoteInfo] = await connection.getMultipleAccountsInfo(
      [new PublicKey(pos.poolBaseVault), new PublicKey(pos.poolQuoteVault)],
      "confirmed"
    );
    if (!baseInfo || !quoteInfo) return null;
    const baseAmount = decodeTokenAccountAmount(baseInfo.data.toString("base64"));
    const quoteAmount = decodeTokenAccountAmount(quoteInfo.data.toString("base64"));
    const rawSold = BigInt(
      Math.max(0, Math.floor(pos.tokenAmount * 10 ** pos.poolBaseDecimals))
    );
    if (rawSold <= 0n) return null;
    // Fees: PumpSwap = 30 bps, Raydium AMM v4 = 25 bps, CPMM = 25 bps.
    const feeBps =
      pos.monitorType === "raydium_amm_v4" || pos.monitorType === "raydium_cpmm" ? 25 : 30;
    const outRaw = getConstantProductOutputRaw(baseAmount, quoteAmount, rawSold, feeBps);
    return Number(outRaw) / LAMPORTS_PER_SOL;
  } catch {
    return null;
  }
}
