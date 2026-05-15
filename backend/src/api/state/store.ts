import fs from "fs/promises";
import path from "path";
import { db } from "../db/sqlite";
import type {
  ActivePosition,
  ApiState,
  BotSettings,
  BotWalletSnapshot,
  ClosedPosition,
  PlatformName,
  TrackedTrader
} from "../types";
import { defaultState } from "./defaultState";

const legacyStateFilePath = path.resolve(__dirname, "../../../data/state.json");

type LegacyState = Partial<ApiState> & {
  settings?: Partial<ApiState["settings"]> & { buyAmountUsd?: number };
};

type DbTrackedTrader = {
  address: string;
  label: string | null;
  enabled: number;
  created_at: string;
};

type DbActivePosition = {
  id: string;
  token_symbol: string;
  token_metadata_symbol: string | null;
  token_name: string | null;
  token_mint: string;
  token_image: string | null;
  source_trader: string;
  buy_platform: string;
  buy_tx: string | null;
  entry_price_usd: number;
  current_price_usd: number;
  amount_usd: number;
  sol_spent: number | null;
  token_amount: number;
  opened_at: string;
  status: string;
};

type DbClosedPosition = {
  id: string;
  token_symbol: string;
  token_metadata_symbol: string | null;
  token_name: string | null;
  token_mint: string;
  token_image: string | null;
  source_trader: string;
  buy_platform: string;
  buy_tx: string | null;
  entry_price_usd: number;
  exit_price_usd: number;
  amount_usd: number;
  sol_spent: number | null;
  token_amount: number;
  opened_at: string;
  exit_platform: string;
  closed_at: string;
  close_reason: string;
  sell_tx: string | null;
};

type DbSettings = {
  profit_target_multiplier: number;
  stop_loss_multiplier?: number;
  position_timeout_minutes?: number;
  buy_amount_sol: number;
};

type DbWallet = {
  address: string;
  sol_balance: number;
  sol_price_usd: number;
  realized_pnl_today_usd: number;
  last_updated: string;
};

function now() {
  return new Date().toISOString();
}

function runTransaction<T>(callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeState(state: LegacyState): ApiState {
  const { buyAmountUsd: _legacyBuyAmountUsd, ...cleanSettings } = state.settings || {};

  return {
    ...defaultState,
    ...state,
    settings: {
      ...defaultState.settings,
      ...cleanSettings,
      ...(state.settings?.buyAmountSol === undefined && state.settings?.buyAmountUsd !== undefined
        ? { buyAmountSol: 0.03 }
        : {})
    },
    wallet: {
      ...defaultState.wallet,
      ...state.wallet
    },
    trackedTraders: state.trackedTraders ?? defaultState.trackedTraders,
    activePositions: state.activePositions ?? defaultState.activePositions,
    closedPositions: state.closedPositions ?? defaultState.closedPositions
  };
}

async function readLegacyState() {
  try {
    const raw = await fs.readFile(legacyStateFilePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return defaultState;
  }
}

function toTrackedTrader(row: DbTrackedTrader): TrackedTrader {
  return {
    address: row.address,
    label: row.label || undefined,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at
  };
}

function toPlatformName(value: string): PlatformName {
  if (["Raydium", "Orca", "Meteora", "Pump.fun", "PumpSwap", "Jupiter"].includes(value)) {
    return value as PlatformName;
  }

  return "Raydium";
}

function toActivePosition(row: DbActivePosition): ActivePosition {
  return {
    id: row.id,
    tokenSymbol: row.token_metadata_symbol || row.token_symbol,
    tokenName: row.token_name || undefined,
    tokenMint: row.token_mint,
    tokenImage: row.token_image || undefined,
    sourceTrader: row.source_trader,
    buyPlatform: toPlatformName(row.buy_platform),
    buyTx: row.buy_tx || undefined,
    entryPriceUsd: row.entry_price_usd,
    currentPriceUsd: row.current_price_usd,
    amountUsd: row.amount_usd,
    solSpent: row.sol_spent ?? undefined,
    tokenAmount: row.token_amount,
    openedAt: row.opened_at,
    status: row.status === "selling" ? "selling" : "open"
  };
}

function toClosedPosition(row: DbClosedPosition): ClosedPosition {
  const closeReason = ["take-profit", "manual", "stop-loss", "timeout"].includes(row.close_reason)
    ? row.close_reason
    : "manual";

  return {
    id: row.id,
    tokenSymbol: row.token_metadata_symbol || row.token_symbol,
    tokenName: row.token_name || undefined,
    tokenMint: row.token_mint,
    tokenImage: row.token_image || undefined,
    sourceTrader: row.source_trader,
    buyPlatform: toPlatformName(row.buy_platform),
    buyTx: row.buy_tx || undefined,
    entryPriceUsd: row.entry_price_usd,
    exitPriceUsd: row.exit_price_usd,
    amountUsd: row.amount_usd,
    solSpent: row.sol_spent ?? undefined,
    tokenAmount: row.token_amount,
    openedAt: row.opened_at,
    exitPlatform: toPlatformName(row.exit_platform),
    closedAt: row.closed_at,
    closeReason: closeReason as ClosedPosition["closeReason"],
    sellTx: row.sell_tx || undefined
  };
}

function isDatabaseEmpty() {
  const row = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM bot_settings) +
          (SELECT COUNT(*) FROM tracked_traders) +
          (SELECT COUNT(*) FROM active_positions) +
          (SELECT COUNT(*) FROM closed_positions) +
          (SELECT COUNT(*) FROM bot_wallet) AS total
      `
    )
    .get() as { total: number };

  return row.total === 0;
}

async function ensureSeeded() {
  if (!isDatabaseEmpty()) {
    return;
  }

  await writeState(await readLegacyState());
}

export async function readState(): Promise<ApiState> {
  await ensureSeeded();

  const settings = db
    .prepare(
      "SELECT profit_target_multiplier, stop_loss_multiplier, position_timeout_minutes, buy_amount_sol FROM bot_settings WHERE id = ?"
    )
    .get("default") as DbSettings | undefined;
  const wallet = db
    .prepare(
      "SELECT address, sol_balance, sol_price_usd, realized_pnl_today_usd, last_updated FROM bot_wallet WHERE id = ?"
    )
    .get("default") as DbWallet | undefined;

  const trackedTraders = db
    .prepare("SELECT address, label, enabled, created_at FROM tracked_traders ORDER BY created_at DESC")
    .all() as DbTrackedTrader[];
  const activePositions = db
    .prepare(
      `
        SELECT
          active_positions.*,
          token_metadata.name AS token_name,
          token_metadata.symbol AS token_metadata_symbol,
          token_metadata.image AS token_image
        FROM active_positions
        LEFT JOIN token_metadata ON token_metadata.mint = active_positions.token_mint
        ORDER BY active_positions.opened_at DESC
      `
    )
    .all() as DbActivePosition[];
  const closedPositions = db
    .prepare(
      `
        SELECT
          closed_positions.*,
          token_metadata.name AS token_name,
          token_metadata.symbol AS token_metadata_symbol,
          token_metadata.image AS token_image
        FROM closed_positions
        LEFT JOIN token_metadata ON token_metadata.mint = closed_positions.token_mint
        ORDER BY closed_positions.closed_at DESC
      `
    )
    .all() as DbClosedPosition[];

  return normalizeState({
    settings: settings
      ? {
          profitTargetMultiplier: settings.profit_target_multiplier,
          stopLossMultiplier: settings.stop_loss_multiplier ?? defaultState.settings.stopLossMultiplier,
          positionTimeoutMinutes:
            settings.position_timeout_minutes ?? defaultState.settings.positionTimeoutMinutes,
          buyAmountSol: settings.buy_amount_sol
        }
      : defaultState.settings,
    trackedTraders: trackedTraders.map(toTrackedTrader),
    activePositions: activePositions.map(toActivePosition),
    closedPositions: closedPositions.map(toClosedPosition),
    wallet: wallet
      ? {
          address: wallet.address,
          solBalance: wallet.sol_balance,
          solPriceUsd: wallet.sol_price_usd,
          realizedPnlTodayUsd: wallet.realized_pnl_today_usd,
          lastUpdated: wallet.last_updated
        }
      : defaultState.wallet
  });
}

export async function writeState(state: ApiState): Promise<ApiState> {
  const nextState = normalizeState(state);
  const savedAt = now();
  db.exec("BEGIN");

  try {
    db.prepare(
      `
        INSERT INTO bot_settings (
          id, profit_target_multiplier, stop_loss_multiplier, position_timeout_minutes, buy_amount_sol, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          profit_target_multiplier = excluded.profit_target_multiplier,
          stop_loss_multiplier = excluded.stop_loss_multiplier,
          position_timeout_minutes = excluded.position_timeout_minutes,
          buy_amount_sol = excluded.buy_amount_sol,
          updated_at = excluded.updated_at
      `
    ).run(
      "default",
      nextState.settings.profitTargetMultiplier,
      nextState.settings.stopLossMultiplier,
      nextState.settings.positionTimeoutMinutes,
      nextState.settings.buyAmountSol,
      savedAt
    );

    db.prepare(
      `
        INSERT INTO bot_wallet (
          id, address, sol_balance, sol_price_usd, realized_pnl_today_usd, last_updated, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          address = excluded.address,
          sol_balance = excluded.sol_balance,
          sol_price_usd = excluded.sol_price_usd,
          realized_pnl_today_usd = excluded.realized_pnl_today_usd,
          last_updated = excluded.last_updated,
          updated_at = excluded.updated_at
      `
    ).run(
      "default",
      nextState.wallet.address,
      nextState.wallet.solBalance,
      nextState.wallet.solPriceUsd,
      nextState.wallet.realizedPnlTodayUsd,
      nextState.wallet.lastUpdated,
      savedAt
    );

    const insertTrader = db.prepare(
      `
        INSERT INTO tracked_traders (address, label, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET
          label = excluded.label,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `
    );
    for (const trader of nextState.trackedTraders) {
      insertTrader.run(trader.address, trader.label || null, trader.enabled ? 1 : 0, trader.createdAt, savedAt);
    }

    for (const position of nextState.activePositions) {
      insertActivePosition(position, savedAt);
    }

    for (const position of nextState.closedPositions) {
      insertClosedPosition(position, savedAt);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return nextState;
}

export async function updateState(updater: (state: ApiState) => ApiState | Promise<ApiState>) {
  const state = await readState();
  const nextState = normalizeState(await updater(state));

  runTransaction(() => {
    const savedAt = now();
    db.prepare(
      `
        INSERT INTO bot_settings (
          id, profit_target_multiplier, stop_loss_multiplier, position_timeout_minutes, buy_amount_sol, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          profit_target_multiplier = excluded.profit_target_multiplier,
          stop_loss_multiplier = excluded.stop_loss_multiplier,
          position_timeout_minutes = excluded.position_timeout_minutes,
          buy_amount_sol = excluded.buy_amount_sol,
          updated_at = excluded.updated_at
      `
    ).run(
      "default",
      nextState.settings.profitTargetMultiplier,
      nextState.settings.stopLossMultiplier,
      nextState.settings.positionTimeoutMinutes,
      nextState.settings.buyAmountSol,
      savedAt
    );
    db.prepare(
      `
        INSERT INTO bot_wallet (
          id, address, sol_balance, sol_price_usd, realized_pnl_today_usd, last_updated, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          address = excluded.address,
          sol_balance = excluded.sol_balance,
          sol_price_usd = excluded.sol_price_usd,
          realized_pnl_today_usd = excluded.realized_pnl_today_usd,
          last_updated = excluded.last_updated,
          updated_at = excluded.updated_at
      `
    ).run(
      "default",
      nextState.wallet.address,
      nextState.wallet.solBalance,
      nextState.wallet.solPriceUsd,
      nextState.wallet.realizedPnlTodayUsd,
      nextState.wallet.lastUpdated,
      savedAt
    );

    const nextTraderAddresses = new Set(nextState.trackedTraders.map((trader) => trader.address));
    const nextActiveIds = new Set(nextState.activePositions.map((position) => position.id));
    const nextClosedIds = new Set(nextState.closedPositions.map((position) => position.id));

    for (const trader of nextState.trackedTraders) {
      db.prepare(
        `
          INSERT INTO tracked_traders (address, label, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(address) DO UPDATE SET
            label = excluded.label,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
        `
      ).run(trader.address, trader.label || null, trader.enabled ? 1 : 0, trader.createdAt, savedAt);
    }
    for (const trader of state.trackedTraders) {
      if (!nextTraderAddresses.has(trader.address)) {
        db.prepare("DELETE FROM tracked_traders WHERE address = ?").run(trader.address);
      }
    }

    for (const position of nextState.activePositions) {
      insertActivePosition(position, savedAt);
    }
    for (const position of state.activePositions) {
      if (!nextActiveIds.has(position.id)) {
        db.prepare("DELETE FROM active_positions WHERE id = ?").run(position.id);
      }
    }

    for (const position of nextState.closedPositions) {
      insertClosedPosition(position, savedAt);
    }
    for (const position of state.closedPositions) {
      if (!nextClosedIds.has(position.id)) {
        db.prepare("DELETE FROM closed_positions WHERE id = ?").run(position.id);
      }
    }
  });

  return readState();
}

export async function saveSettings(settings: BotSettings) {
  const savedAt = now();
  db.prepare(
    `
      INSERT INTO bot_settings (
        id, profit_target_multiplier, stop_loss_multiplier, position_timeout_minutes, buy_amount_sol, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profit_target_multiplier = excluded.profit_target_multiplier,
        stop_loss_multiplier = excluded.stop_loss_multiplier,
        position_timeout_minutes = excluded.position_timeout_minutes,
        buy_amount_sol = excluded.buy_amount_sol,
        updated_at = excluded.updated_at
    `
  ).run(
    "default",
    settings.profitTargetMultiplier,
    settings.stopLossMultiplier,
    settings.positionTimeoutMinutes,
    settings.buyAmountSol,
    savedAt
  );

  return readState();
}

export async function saveWallet(wallet: BotWalletSnapshot) {
  const savedAt = now();
  db.prepare(
    `
      INSERT INTO bot_wallet (
        id, address, sol_balance, sol_price_usd, realized_pnl_today_usd, last_updated, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        address = excluded.address,
        sol_balance = excluded.sol_balance,
        sol_price_usd = excluded.sol_price_usd,
        realized_pnl_today_usd = excluded.realized_pnl_today_usd,
        last_updated = excluded.last_updated,
        updated_at = excluded.updated_at
    `
  ).run(
    "default",
    wallet.address,
    wallet.solBalance,
    wallet.solPriceUsd,
    wallet.realizedPnlTodayUsd,
    wallet.lastUpdated,
    savedAt
  );

  return readState();
}

export async function addTrackedTrader(trader: TrackedTrader) {
  db.prepare(
    `
      INSERT OR IGNORE INTO tracked_traders (address, label, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(trader.address, trader.label || null, trader.enabled ? 1 : 0, trader.createdAt, now());

  return readState();
}

export async function patchTrackedTrader(
  address: string,
  patch: Partial<Pick<TrackedTrader, "label" | "enabled">>
) {
  const current = db
    .prepare("SELECT address, label, enabled, created_at FROM tracked_traders WHERE address = ?")
    .get(address) as DbTrackedTrader | undefined;

  if (!current) {
    return readState();
  }

  db.prepare(
    `
      UPDATE tracked_traders
      SET label = ?, enabled = ?, updated_at = ?
      WHERE address = ?
    `
  ).run(
    patch.label !== undefined ? patch.label || null : current.label,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled,
    now(),
    address
  );

  return readState();
}

export async function deleteTrackedTrader(address: string) {
  db.prepare("DELETE FROM tracked_traders WHERE address = ?").run(address);
  return readState();
}

function insertActivePosition(position: ActivePosition, savedAt: string) {
  db.prepare(
    `
      INSERT INTO active_positions (
        id, token_symbol, token_mint, source_trader, buy_platform, buy_tx, entry_price_usd,
        current_price_usd, amount_usd, sol_spent, token_amount, opened_at, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token_symbol = excluded.token_symbol,
        token_mint = excluded.token_mint,
        source_trader = excluded.source_trader,
        buy_platform = excluded.buy_platform,
        buy_tx = excluded.buy_tx,
        entry_price_usd = excluded.entry_price_usd,
        current_price_usd = excluded.current_price_usd,
        amount_usd = excluded.amount_usd,
        sol_spent = excluded.sol_spent,
        token_amount = excluded.token_amount,
        opened_at = excluded.opened_at,
        status = excluded.status,
        updated_at = excluded.updated_at
    `
  ).run(
    position.id,
    position.tokenSymbol,
    position.tokenMint,
    position.sourceTrader,
    position.buyPlatform,
    position.buyTx || null,
    position.entryPriceUsd,
    position.currentPriceUsd,
    position.amountUsd,
    position.solSpent ?? null,
    position.tokenAmount,
    position.openedAt,
    position.status,
    savedAt,
    savedAt
  );
}

function insertClosedPosition(position: ClosedPosition, savedAt: string) {
  db.prepare(
    `
      INSERT INTO closed_positions (
        id, token_symbol, token_mint, source_trader, buy_platform, buy_tx, entry_price_usd,
        exit_price_usd, amount_usd, sol_spent, token_amount, opened_at, exit_platform,
        closed_at, close_reason, sell_tx, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        token_symbol = excluded.token_symbol,
        token_mint = excluded.token_mint,
        source_trader = excluded.source_trader,
        buy_platform = excluded.buy_platform,
        buy_tx = excluded.buy_tx,
        entry_price_usd = excluded.entry_price_usd,
        exit_price_usd = excluded.exit_price_usd,
        amount_usd = excluded.amount_usd,
        sol_spent = excluded.sol_spent,
        token_amount = excluded.token_amount,
        opened_at = excluded.opened_at,
        exit_platform = excluded.exit_platform,
        closed_at = excluded.closed_at,
        close_reason = excluded.close_reason,
        sell_tx = excluded.sell_tx
    `
  ).run(
    position.id,
    position.tokenSymbol,
    position.tokenMint,
    position.sourceTrader,
    position.buyPlatform,
    position.buyTx || null,
    position.entryPriceUsd,
    position.exitPriceUsd,
    position.amountUsd,
    position.solSpent ?? null,
    position.tokenAmount,
    position.openedAt,
    position.exitPlatform,
    position.closedAt,
    position.closeReason,
    position.sellTx || null,
    savedAt
  );
}

export async function addActivePosition(position: ActivePosition, wallet?: BotWalletSnapshot) {
  runTransaction(() => {
    const savedAt = now();
    insertActivePosition(position, savedAt);

    if (wallet) {
      db.prepare(
        `
          INSERT INTO bot_wallet (
            id, address, sol_balance, sol_price_usd, realized_pnl_today_usd, last_updated, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            address = excluded.address,
            sol_balance = excluded.sol_balance,
            sol_price_usd = excluded.sol_price_usd,
            realized_pnl_today_usd = excluded.realized_pnl_today_usd,
            last_updated = excluded.last_updated,
            updated_at = excluded.updated_at
        `
      ).run(
        "default",
        wallet.address,
        wallet.solBalance,
        wallet.solPriceUsd,
        wallet.realizedPnlTodayUsd,
        wallet.lastUpdated,
        savedAt
      );
    }
  });

  return readState();
}

export async function patchActivePosition(
  id: string,
  patch: Partial<Pick<ActivePosition, "currentPriceUsd" | "status" | "buyTx">>
) {
  const current = db.prepare("SELECT * FROM active_positions WHERE id = ?").get(id) as DbActivePosition | undefined;

  if (!current) {
    return readState();
  }

  db.prepare(
    `
      UPDATE active_positions
      SET current_price_usd = ?, status = ?, buy_tx = ?, updated_at = ?
      WHERE id = ?
    `
  ).run(
    patch.currentPriceUsd ?? current.current_price_usd,
    patch.status ?? current.status,
    patch.buyTx !== undefined ? patch.buyTx || null : current.buy_tx,
    now(),
    id
  );

  return readState();
}

export async function deleteActivePosition(id: string) {
  db.prepare("DELETE FROM active_positions WHERE id = ?").run(id);
  return readState();
}

export async function closeActivePosition(position: ClosedPosition, pnlUsd: number, wallet?: BotWalletSnapshot) {
  runTransaction(() => {
    const savedAt = now();
    db.prepare("DELETE FROM active_positions WHERE id = ?").run(position.id);
    insertClosedPosition(position, savedAt);

    if (wallet) {
      db.prepare(
        `
          INSERT INTO bot_wallet (
            id, address, sol_balance, sol_price_usd, realized_pnl_today_usd, last_updated, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            address = excluded.address,
            sol_balance = excluded.sol_balance,
            sol_price_usd = excluded.sol_price_usd,
            realized_pnl_today_usd = excluded.realized_pnl_today_usd,
            last_updated = excluded.last_updated,
            updated_at = excluded.updated_at
        `
      ).run(
        "default",
        wallet.address,
        wallet.solBalance,
        wallet.solPriceUsd,
        wallet.realizedPnlTodayUsd + pnlUsd,
        new Date().toISOString(),
        savedAt
      );
      return;
    }

    db.prepare(
      `
        UPDATE bot_wallet
        SET realized_pnl_today_usd = realized_pnl_today_usd + ?,
            last_updated = ?,
            updated_at = ?
        WHERE id = ?
      `
    ).run(pnlUsd, new Date().toISOString(), savedAt, "default");
  });

  return readState();
}
