import { db } from "../db/sqlite";
import { getTokenMetadata } from "./tokenMetadata";

export type BlacklistedToken = {
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenImage?: string;
  reason?: string;
  createdAt: string;
};

function now() {
  return new Date().toISOString();
}

function normalizeReason(reason?: string) {
  const value = reason?.trim();
  return value ? value.slice(0, 180) : undefined;
}

export function isTokenBlacklisted(tokenMint: string) {
  const row = db.prepare("SELECT token_mint FROM blacklisted_tokens WHERE token_mint = ?").get(tokenMint);
  return Boolean(row);
}

export async function listBlacklistedTokens(): Promise<BlacklistedToken[]> {
  const rows = db
    .prepare(
      `
        SELECT
          blacklisted_tokens.token_mint,
          blacklisted_tokens.reason,
          blacklisted_tokens.created_at,
          token_metadata.symbol,
          token_metadata.name,
          token_metadata.image
        FROM blacklisted_tokens
        LEFT JOIN token_metadata ON token_metadata.mint = blacklisted_tokens.token_mint
        ORDER BY blacklisted_tokens.created_at DESC
      `
    )
    .all() as Array<{
    token_mint: string;
    reason?: string | null;
    created_at: string;
    symbol?: string | null;
    name?: string | null;
    image?: string | null;
  }>;

  return rows.map((row) => ({
    tokenMint: row.token_mint,
    tokenSymbol: row.symbol || row.token_mint.slice(0, 6),
    tokenName: row.name || undefined,
    tokenImage: row.image || undefined,
    reason: row.reason || undefined,
    createdAt: row.created_at
  }));
}

export async function addBlacklistedToken(tokenMint: string, reason?: string) {
  await getTokenMetadata(tokenMint).catch(() => undefined);

  const savedAt = now();
  db.prepare(
    `
      INSERT INTO blacklisted_tokens (token_mint, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(token_mint) DO UPDATE SET
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `
  ).run(tokenMint, normalizeReason(reason) || null, savedAt, savedAt);

  return listBlacklistedTokens();
}

export function deleteBlacklistedToken(tokenMint: string) {
  const result = db.prepare("DELETE FROM blacklisted_tokens WHERE token_mint = ?").run(tokenMint);
  return result.changes > 0;
}
