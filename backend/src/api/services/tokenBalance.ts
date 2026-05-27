/**
 * Read live on-chain ATA balance. The sell flow ALWAYS trusts this value —
 * never position.tokenAmount from DB — because:
 *   • Pump.fun / Token-2022 may bake transfer fees into the received amount, so
 *     the actual balance is lower than the quote-time estimate
 *   • Partial fills under slippage can leave us with less than asked
 *   • Airdrops or merges can bump the balance above the DB record
 *
 * Selling exactly the on-chain balance leaves no dust → the ATA hits 0 → we can
 * close it and recover the ~0.00204 SOL rent deposit. Dust = stuck rent.
 */
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress
} from "@solana/spl-token";
import { getMintInfo } from "./caches/mintInfoCache";

export type ActualTokenBalance = {
  ata: PublicKey;
  /** Raw (smallest-unit) balance as BN — pass directly to SDK sell calls. */
  balanceRaw: BN;
  /** UI-friendly balance (raw / 10^decimals). For logging and DB accounting. */
  uiAmount: number;
  /** Mint decimals. */
  decimals: number;
  /** SPL Token program that owns the mint (legacy or Token-2022). */
  tokenProgram: PublicKey;
};

/**
 * Throws if the ATA doesn't exist or holds 0 tokens — caller should treat as
 * "nothing to sell" and bail without burning a tx.
 */
export async function getActualTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<ActualTokenBalance> {
  // mintInfoCache memoises owner + decimals (immutable per mint), saving ~80ms
  // per sell call on a cache hit.
  const { tokenProgram } = await getMintInfo(connection, mint);

  const ata = await getAssociatedTokenAddress(mint, wallet, false, tokenProgram);

  let parsed;
  try {
    parsed = await connection.getTokenAccountBalance(ata, "confirmed");
  } catch {
    throw new Error(
      `ATA ${ata.toBase58().slice(0, 8)} not found for mint ${mint.toBase58().slice(0, 8)} — nothing to sell`
    );
  }

  const balanceRaw = new BN(parsed.value.amount);
  if (balanceRaw.isZero()) {
    throw new Error(
      `ATA ${ata.toBase58().slice(0, 8)} holds 0 tokens — nothing to sell`
    );
  }
  const decimals = parsed.value.decimals;
  const uiAmount = parsed.value.uiAmount ?? Number(parsed.value.amount) / 10 ** decimals;

  return { ata, balanceRaw, uiAmount, decimals, tokenProgram };
}
