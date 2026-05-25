import { randomUUID } from "crypto";
import { db } from "../db/sqlite";
import type { BotLog, BotLogLevel } from "../types";

type CreateLogInput = {
  level?: BotLogLevel;
  event: string;
  message: string;
  wallet?: string;
  trader?: string;
  tokenMint?: string;
  signature?: string;
  positionId?: string;
  metadata?: Record<string, unknown>;
};

type DbLog = {
  id: string;
  level: BotLogLevel;
  event: string;
  message: string;
  wallet: string | null;
  trader: string | null;
  token_mint: string | null;
  signature: string | null;
  position_id: string | null;
  metadata: string | null;
  created_at: string;
};

function toLog(row: DbLog): BotLog {
  return {
    id: row.id,
    level: row.level,
    event: row.event,
    message: row.message,
    wallet: row.wallet || row.trader || undefined,
    trader: row.trader || undefined,
    tokenMint: row.token_mint || undefined,
    signature: row.signature || undefined,
    positionId: row.position_id || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at
  };
}

export function createBotLog(input: CreateLogInput) {
  const log: BotLog = {
    id: randomUUID(),
    level: input.level || "info",
    event: input.event,
    message: input.message,
    wallet: input.wallet || input.trader,
    trader: input.trader,
    tokenMint: input.tokenMint,
    signature: input.signature,
    positionId: input.positionId,
    metadata: input.metadata,
    createdAt: new Date().toISOString()
  };

  db.prepare(
    `
      INSERT INTO bot_logs (
        id, level, event, message, wallet, trader, token_mint, signature, position_id, metadata, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    log.id,
    log.level,
    log.event,
    log.message,
    log.wallet || null,
    log.trader || null,
    log.tokenMint || null,
    log.signature || null,
    log.positionId || null,
    log.metadata ? JSON.stringify(log.metadata) : null,
    log.createdAt
  );

  return log;
}

export function listBotLogs(limit = 200, event?: string) {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 && limit <= 1000 ? limit : 200;
  const normalizedEvent = event?.trim();
  const rows = normalizedEvent
    ? (db
        .prepare("SELECT * FROM bot_logs WHERE event = ? ORDER BY created_at DESC LIMIT ?")
        .all(normalizedEvent, normalizedLimit) as DbLog[])
    : (db
        .prepare("SELECT * FROM bot_logs ORDER BY created_at DESC LIMIT ?")
        .all(normalizedLimit) as DbLog[]);
  return rows.map(toLog);
}

export function listBotLogEvents() {
  const rows = db
    .prepare("SELECT DISTINCT event FROM bot_logs ORDER BY event ASC")
    .all() as Array<{ event: string }>;
  return rows.map((row) => row.event);
}

export function deleteBotLog(id: string) {
  const result = db.prepare("DELETE FROM bot_logs WHERE id = ?").run(id);
  return result.changes > 0;
}

export function deleteBotLogsByEvent(event: string) {
  const result = db.prepare("DELETE FROM bot_logs WHERE event = ?").run(event);
  return result.changes;
}

export function deleteAllBotLogs() {
  const result = db.prepare("DELETE FROM bot_logs").run();
  return result.changes;
}
