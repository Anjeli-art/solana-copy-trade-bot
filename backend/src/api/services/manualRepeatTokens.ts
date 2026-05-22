import { db } from "../db/sqlite";
import { readState } from "../state/store";
import type { PlatformName } from "../types";

export type ManualRepeatToken = {
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  tokenImage?: string;
  platform: PlatformName;
};

function now() {
  return new Date().toISOString();
}

export async function listManualRepeatTokens(): Promise<ManualRepeatToken[]> {
  const state = await readState();
  const positions = [...state.activePositions, ...state.closedPositions];
  const seen = new Set<string>();
  const savedAt = now();
  const insertToken = db.prepare(
    `
      INSERT INTO manual_repeat_tokens (token_mint, hidden, created_at, updated_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(token_mint) DO UPDATE SET
        updated_at = excluded.updated_at
    `
  );
  const hiddenRows = db
    .prepare("SELECT token_mint FROM manual_repeat_tokens WHERE hidden = 1")
    .all() as Array<{ token_mint: string }>;
  const hidden = new Set(hiddenRows.map((row) => row.token_mint));
  const tokens: ManualRepeatToken[] = [];

  for (const position of positions) {
    if (seen.has(position.tokenMint)) {
      continue;
    }

    seen.add(position.tokenMint);
    insertToken.run(position.tokenMint, savedAt, savedAt);

    if (hidden.has(position.tokenMint)) {
      continue;
    }

    tokens.push({
      tokenMint: position.tokenMint,
      tokenSymbol: position.tokenSymbol,
      tokenName: position.tokenName,
      tokenImage: position.tokenImage,
      platform: position.buyPlatform
    });
  }

  return tokens;
}

export function hideManualRepeatToken(tokenMint: string) {
  const savedAt = now();
  const result = db
    .prepare(
      `
        INSERT INTO manual_repeat_tokens (token_mint, hidden, created_at, updated_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(token_mint) DO UPDATE SET
          hidden = 1,
          updated_at = excluded.updated_at
      `
    )
    .run(tokenMint, savedAt, savedAt);

  return result.changes > 0;
}
