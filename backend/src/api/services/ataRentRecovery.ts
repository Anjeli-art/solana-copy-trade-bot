/**
 * ATA (Associated Token Account) rent recovery.
 *
 * Every token account on Solana holds ~0.00204 SOL as rent deposit. When a token
 * account is emptied (token balance = 0), that rent stays locked unless the account
 * is explicitly closed via the `closeAccount` SPL Token instruction. The rent
 * returns to the destination wallet when closed.
 *
 * Each accumulated empty ATA = ~0.00204 SOL = ~$0.37 stuck.
 *
 * Two helpers:
 *   - closeTokenAccountIfEmpty: called right after a successful sell to drain rent
 *     from the freshly-emptied ATA. Safe to call even if balance is non-zero —
 *     it pre-checks and skips in that case.
 *   - sweepAllEmptyTokenAccounts: one-shot manual cleanup that scans the wallet's
 *     token accounts and closes every empty one. Useful for already-stuck rent.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token";
import { createBotLog } from "./logs";
import { db } from "../db/sqlite";
import { getMintInfo } from "./caches/mintInfoCache";
import { getCachedBlockhash } from "./caches/blockhashCache";

/**
 * Credit recovered ATA rent to the most recently closed position for this token mint.
 * Looks in both `closed_positions` (copy trades) and `mirror_closed_positions` and
 * picks the most recent. Returns true if a row was updated.
 */
function creditRentToClosedPosition(mint: string, recoveredLamports: number): boolean {
  const recoveredSol = recoveredLamports / 1e9;
  // Look in the last 24 hours so we don't pick up an unrelated old position.
  const recentCopy = db
    .prepare(
      "SELECT id, closed_at FROM closed_positions WHERE token_mint = ? AND ata_rent_recovered = 0 AND closed_at > datetime('now','-24 hours') ORDER BY closed_at DESC LIMIT 1"
    )
    .get(mint) as { id: string; closed_at: string } | undefined;
  const recentMirror = db
    .prepare(
      "SELECT id, closed_at FROM mirror_closed_positions WHERE token_mint = ? AND ata_rent_recovered = 0 AND closed_at > datetime('now','-24 hours') ORDER BY closed_at DESC LIMIT 1"
    )
    .get(mint) as { id: string; closed_at: string } | undefined;

  // Pick whichever was closed later (most likely the one whose ATA we just emptied).
  let target: { table: string; id: string } | null = null;
  if (recentCopy && recentMirror) {
    target = recentCopy.closed_at >= recentMirror.closed_at
      ? { table: "closed_positions", id: recentCopy.id }
      : { table: "mirror_closed_positions", id: recentMirror.id };
  } else if (recentCopy) {
    target = { table: "closed_positions", id: recentCopy.id };
  } else if (recentMirror) {
    target = { table: "mirror_closed_positions", id: recentMirror.id };
  }
  if (!target) return false;

  db.prepare(
    `UPDATE ${target.table} SET ata_rent_recovered = ? WHERE id = ?`
  ).run(recoveredSol, target.id);
  return true;
}

const CLOSE_PRIORITY_FEE_MICRO_LAMPORTS = 10_000;
const CLOSE_COMPUTE_UNIT_LIMIT = 40_000;

/**
 * Read on-chain balance of an ATA. Returns null if the account doesn't exist.
 */
async function readAtaBalanceRaw(
  connection: Connection,
  ata: PublicKey
): Promise<bigint | null> {
  const info = await connection.getAccountInfo(ata);
  if (!info) return null;
  // SPL Token / Token-2022 amount field is u64 at offset 64 (layout identical for both).
  if (info.data.length < 72) return null;
  return info.data.readBigUInt64LE(64);
}

/**
 * Pump.fun and a handful of other launchpads now mint Token-2022 tokens. The ATA
 * derivation and the close instruction need the *exact* token program that owns
 * the mint. mintInfoCache memoises this lookup — saves ~80ms per ATA close.
 */
async function detectMintTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  try {
    const { tokenProgram } = await getMintInfo(connection, mint);
    return tokenProgram;
  } catch {
    return TOKEN_PROGRAM_ID;
  }
}

/**
 * If the ATA for (wallet, mint) exists and holds zero tokens, close it to recover
 * the rent. Safe no-op if the account holds tokens or doesn't exist. Returns the
 * amount of SOL (lamports) recovered, or 0 if nothing happened.
 */
export async function closeTokenAccountIfEmpty(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey
): Promise<number> {
  const tokenProgram = await detectMintTokenProgram(connection, mint);
  let ata: PublicKey;
  try {
    // `allowOwnerOffCurve=false`, `programId=tokenProgram` — Token-2022 uses the same
    // ATA program but with the 2022 program id baked into the seed derivation.
    ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, tokenProgram);
  } catch {
    return 0;
  }

  const balance = await readAtaBalanceRaw(connection, ata).catch(() => null);
  if (balance === null) {
    // Account doesn't exist on chain — nothing to close. Emitted as info, not warn,
    // because it's a benign case (sell may have happened via a different ATA, or
    // the account was already closed by a prior pass).
    createBotLog({
      level: "info",
      event: "ATA_CLOSE_SKIPPED_NOT_EXISTS",
      message: `ATA ${ata.toBase58().slice(0, 8)} for mint ${mint.toBase58().slice(0, 8)} does not exist — nothing to recover`,
      tokenMint: mint.toBase58(),
      metadata: { ata: ata.toBase58() }
    });
    return 0;
  }
  if (balance > 0n) {
    // Dust or leftover tokens prevented close. We should investigate sells that
    // leave a non-zero balance — likely a slippage round-off or wrong amount sold.
    createBotLog({
      level: "warn",
      event: "ATA_CLOSE_SKIPPED_NON_ZERO_BALANCE",
      message: `ATA ${ata.toBase58().slice(0, 8)} still holds ${balance.toString()} raw tokens — cannot close, rent ~0.00204 SOL stays locked`,
      tokenMint: mint.toBase58(),
      metadata: { ata: ata.toBase58(), residualRawBalance: balance.toString() }
    });
    return 0;
  }

  const lamportsBefore = (await connection.getAccountInfo(ata).catch(() => null))?.lamports ?? 0;
  if (lamportsBefore === 0) {
    // ATA is empty AND has no rent (rare — could happen if closed in the same block by another tx).
    createBotLog({
      level: "info",
      event: "ATA_CLOSE_SKIPPED_NO_RENT",
      message: `ATA ${ata.toBase58().slice(0, 8)} has 0 lamports — already drained, nothing to recover`,
      tokenMint: mint.toBase58(),
      metadata: { ata: ata.toBase58() }
    });
    return 0;
  }

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CLOSE_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CLOSE_PRIORITY_FEE_MICRO_LAMPORTS }),
    createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], tokenProgram)
  ];

  try {
    const { blockhash, lastValidBlockHeight } = await getCachedBlockhash(connection);
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey });
    for (const ix of instructions) tx.add(ix);
    tx.sign(wallet);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2
    });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

    // Credit the recovered rent to the position record so the UI shows correct PnL.
    const credited = creditRentToClosedPosition(mint.toBase58(), lamportsBefore);
    createBotLog({
      event: "ATA_CLOSE_EXECUTED",
      message: `Closed empty ATA ${ata.toBase58().slice(0, 8)} for mint ${mint.toBase58().slice(0, 8)}, recovered ${(lamportsBefore / 1e9).toFixed(6)} SOL`,
      tokenMint: mint.toBase58(),
      signature,
      metadata: {
        ata: ata.toBase58(),
        recoveredLamports: lamportsBefore,
        recoveredSol: lamportsBefore / 1e9,
        attributedToPosition: credited
      }
    });
    return lamportsBefore;
  } catch (error) {
    // Don't fail the parent flow — closing the ATA is opportunistic.
    createBotLog({
      level: "warn",
      event: "ATA_CLOSE_FAILED",
      message: error instanceof Error ? error.message : "Unknown ATA close error",
      tokenMint: mint.toBase58(),
      metadata: { ata: ata.toBase58() }
    });
    return 0;
  }
}

/**
 * One-shot cleanup: enumerate every token account owned by the wallet, close every
 * empty one in batches. Returns total lamports recovered.
 *
 * Sweeps up to `maxAccounts` per call (default 20) so a single big transaction
 * doesn't blow past the size limit. Run repeatedly until 0 accounts remain.
 */
export async function sweepAllEmptyTokenAccounts(
  connection: Connection,
  wallet: Keypair,
  options: { maxAccounts?: number } = {}
): Promise<{ closed: number; recoveredLamports: number }> {
  const maxAccounts = options.maxAccounts ?? 20;
  // Scan BOTH legacy SPL Token and Token-2022. A wallet that has bought Pump.fun
  // *pump mints holds 2022 ATAs; ignoring them leaks rent forever.
  const [legacy, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID })
  ]);

  type EmptyAcc = { pubkey: PublicKey; lamports: number; tokenProgram: PublicKey };
  const empties: EmptyAcc[] = [];
  const collect = (
    response: { value: Array<{ pubkey: PublicKey; account: { data: unknown; lamports: number } }> },
    program: PublicKey
  ) => {
    for (const a of response.value) {
      const parsed = (a.account.data as unknown as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed;
      const amount = parsed?.info?.tokenAmount?.amount;
      if (amount === "0" && a.account.lamports > 0) {
        empties.push({ pubkey: a.pubkey, lamports: a.account.lamports, tokenProgram: program });
      }
    }
  };
  collect(legacy, TOKEN_PROGRAM_ID);
  collect(token2022, TOKEN_2022_PROGRAM_ID);

  if (empties.length === 0) {
    return { closed: 0, recoveredLamports: 0 };
  }

  const batch = empties.slice(0, maxAccounts);
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CLOSE_PRIORITY_FEE_MICRO_LAMPORTS })
  ];
  for (const acc of batch) {
    instructions.push(
      createCloseAccountInstruction(acc.pubkey, wallet.publicKey, wallet.publicKey, [], acc.tokenProgram)
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey });
  for (const ix of instructions) tx.add(ix);
  tx.sign(wallet);

  try {
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    const recoveredLamports = batch.reduce((sum, a) => sum + a.lamports, 0);
    createBotLog({
      event: "ATA_SWEEP_COMPLETED",
      message: `Closed ${batch.length} empty ATAs, recovered ${(recoveredLamports / 1e9).toFixed(6)} SOL`,
      signature,
      metadata: { count: batch.length, recoveredLamports, totalFound: empties.length }
    });
    return { closed: batch.length, recoveredLamports };
  } catch (error) {
    createBotLog({
      level: "error",
      event: "ATA_SWEEP_FAILED",
      message: error instanceof Error ? error.message : "Unknown ATA sweep error",
      metadata: { batchSize: batch.length }
    });
    throw error;
  }
}
