import fs from "fs";
import path from "path";

type SqliteDatabase = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  };
};

type DatabaseSyncConstructor = new (path: string) => SqliteDatabase;

const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

const dataDir = path.resolve(__dirname, "../../../data");
const databasePath = process.env.SQLITE_DATABASE_PATH || path.join(dataDir, "copy-bot.db");

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS bot_settings (
    id TEXT PRIMARY KEY,
    profit_target_multiplier REAL NOT NULL,
    high_profit_target_multiplier REAL NOT NULL DEFAULT 1.05,
    stop_loss_multiplier REAL NOT NULL DEFAULT 0.7,
    position_timeout_minutes REAL NOT NULL DEFAULT 120,
    buy_amount_sol REAL NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracked_traders (
    address TEXT PRIMARY KEY,
    label TEXT,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS active_positions (
    id TEXT PRIMARY KEY,
    token_symbol TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    source_trader TEXT NOT NULL,
    source_signature TEXT,
    buy_platform TEXT NOT NULL,
    buy_tx TEXT,
    entry_price_usd REAL NOT NULL,
    current_price_usd REAL NOT NULL,
    current_price_updated_at TEXT,
    amount_usd REAL NOT NULL,
    sol_spent REAL,
    buy_network_fee_sol REAL,
    buy_priority_fee_sol REAL,
    buy_quoted_out_amount REAL,
    buy_actual_sol_change REAL,
    token_amount REAL NOT NULL,
    opened_at TEXT NOT NULL,
    status TEXT NOT NULL,
    profit_tier TEXT NOT NULL DEFAULT 'low',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS closed_positions (
    id TEXT PRIMARY KEY,
    token_symbol TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    source_trader TEXT NOT NULL,
    source_signature TEXT,
    buy_platform TEXT NOT NULL,
    buy_tx TEXT,
    entry_price_usd REAL NOT NULL,
    exit_price_usd REAL NOT NULL,
    amount_usd REAL NOT NULL,
    sol_spent REAL,
    buy_network_fee_sol REAL,
    buy_priority_fee_sol REAL,
    buy_quoted_out_amount REAL,
    buy_actual_sol_change REAL,
    token_amount REAL NOT NULL,
    opened_at TEXT NOT NULL,
    exit_platform TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    close_reason TEXT NOT NULL,
    profit_tier TEXT NOT NULL DEFAULT 'low',
    sell_tx TEXT,
    sell_network_fee_sol REAL,
    sell_priority_fee_sol REAL,
    sell_quoted_out_sol REAL,
    sell_actual_sol_change REAL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_wallet (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    sol_balance REAL NOT NULL,
    sol_price_usd REAL NOT NULL,
    realized_pnl_today_usd REAL NOT NULL,
    last_updated TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_signatures (
    signature TEXT PRIMARY KEY,
    trader TEXT NOT NULL,
    token_mint TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS copy_buy_token_locks (
    token_mint TEXT PRIMARY KEY,
    source_signature TEXT NOT NULL,
    trader TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_logs (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    wallet TEXT,
    trader TEXT,
    token_mint TEXT,
    signature TEXT,
    position_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS token_metadata (
    mint TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    image TEXT,
    decimals INTEGER,
    is_token_2022 INTEGER NOT NULL DEFAULT 0,
    raw_metadata TEXT,
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS manual_repeat_tokens (
    token_mint TEXT PRIMARY KEY,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blacklisted_tokens (
    token_mint TEXT PRIMARY KEY,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bot_logs_created_at ON bot_logs (created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_token_mint_unique ON active_positions (token_mint);

  CREATE TABLE IF NOT EXISTS running_workers (
    name TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trading_runtime (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mirror_traders (
    address TEXT PRIMARY KEY,
    label TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    buy_amount_sol REAL NOT NULL DEFAULT 0.1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mirror_positions (
    id TEXT PRIMARY KEY,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    mirror_trader TEXT NOT NULL,
    source_buy_signature TEXT,
    buy_tx TEXT,
    entry_price_usd REAL NOT NULL DEFAULT 0,
    current_price_usd REAL NOT NULL DEFAULT 0,
    token_amount REAL NOT NULL,
    sol_spent REAL NOT NULL DEFAULT 0,
    opened_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mirror_closed_positions (
    id TEXT PRIMARY KEY,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    mirror_trader TEXT NOT NULL,
    source_buy_signature TEXT,
    source_sell_signature TEXT,
    buy_tx TEXT,
    sell_tx TEXT,
    entry_price_usd REAL NOT NULL DEFAULT 0,
    exit_price_usd REAL NOT NULL DEFAULT 0,
    token_amount REAL NOT NULL,
    sol_spent REAL NOT NULL DEFAULT 0,
    sol_received REAL,
    close_reason TEXT NOT NULL DEFAULT 'mirror-sell',
    opened_at TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mirror_processed_signatures (
    signature TEXT PRIMARY KEY,
    trader TEXT NOT NULL,
    token_mint TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL
  );
`);

const settingsColumns = db.prepare("PRAGMA table_info(bot_settings)").all() as Array<{ name: string }>;
if (!settingsColumns.some((column) => column.name === "stop_loss_multiplier")) {
  db.exec("ALTER TABLE bot_settings ADD COLUMN stop_loss_multiplier REAL NOT NULL DEFAULT 0.7");
}
if (!settingsColumns.some((column) => column.name === "high_profit_target_multiplier")) {
  db.exec("ALTER TABLE bot_settings ADD COLUMN high_profit_target_multiplier REAL NOT NULL DEFAULT 1.05");
}
if (!settingsColumns.some((column) => column.name === "position_timeout_minutes")) {
  db.exec("ALTER TABLE bot_settings ADD COLUMN position_timeout_minutes REAL NOT NULL DEFAULT 120");
}

const activePositionColumns = db.prepare("PRAGMA table_info(active_positions)").all() as Array<{ name: string }>;
if (!activePositionColumns.some((column) => column.name === "current_price_updated_at")) {
  db.exec(`
    ALTER TABLE active_positions ADD COLUMN current_price_updated_at TEXT;
    UPDATE active_positions
    SET current_price_updated_at = COALESCE(updated_at, opened_at)
    WHERE current_price_updated_at IS NULL;
  `);
}
for (const column of [
  "source_signature",
  "buy_network_fee_sol",
  "buy_priority_fee_sol",
  "buy_quoted_out_amount",
  "buy_actual_sol_change"
]) {
  if (!activePositionColumns.some((activeColumn) => activeColumn.name === column)) {
    db.exec(`ALTER TABLE active_positions ADD COLUMN ${column} ${column === "source_signature" ? "TEXT" : "REAL"}`);
  }
}
if (!activePositionColumns.some((column) => column.name === "profit_tier")) {
  db.exec("ALTER TABLE active_positions ADD COLUMN profit_tier TEXT NOT NULL DEFAULT 'low'");
}
// Pool monitoring fields for direct WebSocket price feed (PumpSwap and future native DEXes).
// pool_address     — pool PDA / bonding curve address
// pool_base_vault  — pool's base (meme) token vault, source of base reserve
// pool_quote_vault — pool's quote (WSOL) token vault, source of quote reserve
// pool_base_decimals — decimals of base token, needed for price math
// monitor_type     — "pumpswap" | "pumpfun" | null. Null = fall back to Jupiter polling.
for (const column of ["pool_address", "pool_base_vault", "pool_quote_vault", "monitor_type"]) {
  if (!activePositionColumns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE active_positions ADD COLUMN ${column} TEXT`);
  }
}
if (!activePositionColumns.some((c) => c.name === "pool_base_decimals")) {
  db.exec("ALTER TABLE active_positions ADD COLUMN pool_base_decimals INTEGER");
}

const closedPositionColumns = db.prepare("PRAGMA table_info(closed_positions)").all() as Array<{ name: string }>;
for (const column of [
  "source_signature",
  "buy_network_fee_sol",
  "buy_priority_fee_sol",
  "buy_quoted_out_amount",
  "buy_actual_sol_change",
  "sell_network_fee_sol",
  "sell_priority_fee_sol",
  "sell_quoted_out_sol",
  "sell_actual_sol_change"
]) {
  if (!closedPositionColumns.some((closedColumn) => closedColumn.name === column)) {
    db.exec(`ALTER TABLE closed_positions ADD COLUMN ${column} ${column === "source_signature" ? "TEXT" : "REAL"}`);
  }
}
if (!closedPositionColumns.some((column) => column.name === "profit_tier")) {
  db.exec("ALTER TABLE closed_positions ADD COLUMN profit_tier TEXT NOT NULL DEFAULT 'low'");
}

const logColumns = db.prepare("PRAGMA table_info(bot_logs)").all() as Array<{ name: string }>;
if (!logColumns.some((column) => column.name === "wallet")) {
  db.exec("ALTER TABLE bot_logs ADD COLUMN wallet TEXT");
}

// Mirror positions also get pool monitoring fields for the same WebSocket price feed.
const mirrorPositionColumns = db.prepare("PRAGMA table_info(mirror_positions)").all() as Array<{ name: string }>;
for (const column of ["pool_address", "pool_base_vault", "pool_quote_vault", "monitor_type", "buy_platform"]) {
  if (!mirrorPositionColumns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE mirror_positions ADD COLUMN ${column} TEXT`);
  }
}
if (!mirrorPositionColumns.some((c) => c.name === "pool_base_decimals")) {
  db.exec("ALTER TABLE mirror_positions ADD COLUMN pool_base_decimals INTEGER");
}

// Mirror closed positions track which venue the original buy was on and which one
// actually executed the sell. The UI uses these to render the platform pill instead of
// a hardcoded "Mirror manual" label.
const mirrorClosedColumns = db.prepare("PRAGMA table_info(mirror_closed_positions)").all() as Array<{ name: string }>;
for (const column of ["buy_platform", "exit_platform"]) {
  if (!mirrorClosedColumns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE mirror_closed_positions ADD COLUMN ${column} TEXT`);
  }
}
// ATA rent that came back when the empty token account was closed after the sell.
// Tracked separately so the UI can show a corrected PnL (rent is a deposit, not a cost).
if (!mirrorClosedColumns.some((c) => c.name === "ata_rent_recovered")) {
  db.exec("ALTER TABLE mirror_closed_positions ADD COLUMN ata_rent_recovered REAL NOT NULL DEFAULT 0");
}
const closedColumnsForRent = db.prepare("PRAGMA table_info(closed_positions)").all() as Array<{ name: string }>;
if (!closedColumnsForRent.some((c) => c.name === "ata_rent_recovered")) {
  db.exec("ALTER TABLE closed_positions ADD COLUMN ata_rent_recovered REAL NOT NULL DEFAULT 0");
}
