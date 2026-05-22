import fs from "fs";
import path from "path";

const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };

const dataDir = path.resolve(__dirname, "../../../data");
const databasePath = process.env.SQLITE_DATABASE_PATH || path.join(dataDir, "copy-bot.db");

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS bot_settings (
    id TEXT PRIMARY KEY,
    profit_target_multiplier REAL NOT NULL,
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
    buy_platform TEXT NOT NULL,
    buy_tx TEXT,
    entry_price_usd REAL NOT NULL,
    current_price_usd REAL NOT NULL,
    current_price_updated_at TEXT,
    amount_usd REAL NOT NULL,
    sol_spent REAL,
    token_amount REAL NOT NULL,
    opened_at TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS closed_positions (
    id TEXT PRIMARY KEY,
    token_symbol TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    source_trader TEXT NOT NULL,
    buy_platform TEXT NOT NULL,
    buy_tx TEXT,
    entry_price_usd REAL NOT NULL,
    exit_price_usd REAL NOT NULL,
    amount_usd REAL NOT NULL,
    sol_spent REAL,
    token_amount REAL NOT NULL,
    opened_at TEXT NOT NULL,
    exit_platform TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    close_reason TEXT NOT NULL,
    sell_tx TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_bot_logs_created_at ON bot_logs (created_at DESC);
`);

const settingsColumns = db.prepare("PRAGMA table_info(bot_settings)").all() as Array<{ name: string }>;
if (!settingsColumns.some((column) => column.name === "stop_loss_multiplier")) {
  db.exec("ALTER TABLE bot_settings ADD COLUMN stop_loss_multiplier REAL NOT NULL DEFAULT 0.7");
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

const logColumns = db.prepare("PRAGMA table_info(bot_logs)").all() as Array<{ name: string }>;
if (!logColumns.some((column) => column.name === "wallet")) {
  db.exec("ALTER TABLE bot_logs ADD COLUMN wallet TEXT");
}
