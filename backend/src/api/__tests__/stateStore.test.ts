import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dbPath = path.join(os.tmpdir(), `copy-bot-test-${Date.now()}-${Math.random()}.db`);
process.env.SQLITE_DATABASE_PATH = dbPath;

test.after(() => {
  for (const suffix of ["", "-shm", "-wal", "-journal"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {}
  }
});

test("state store persists settings, traders and positions in sqlite", async () => {
  const { readState, updateState } = await import("../state/store");

  await updateState((current) => ({
    ...current,
    settings: {
      profitTargetMultiplier: 1.4,
      stopLossMultiplier: 0.6,
      positionTimeoutMinutes: 120,
      buyAmountSol: 0.02
    },
    trackedTraders: [
      {
        address: "3jSHyFJjkWnz73niuzRnjsxSEA6MV3kwKu4ZAFEXGN6f",
        enabled: true,
        createdAt: "2026-05-14T00:00:00.000Z"
      }
    ],
    activePositions: [
      {
        id: "pos-1",
        tokenSymbol: "TOKEN",
        tokenMint: "TokenMint1111111111111111111111111111111111",
        sourceTrader: "3jSHyFJjkWnz73niuzRnjsxSEA6MV3kwKu4ZAFEXGN6f",
        buyPlatform: "PumpSwap",
        buyTx: "buy-tx",
        entryPriceUsd: 0.01,
        currentPriceUsd: 0.014,
        amountUsd: 3,
        solSpent: 0.033,
        tokenAmount: 300,
        openedAt: "2026-05-14T00:01:00.000Z",
        status: "open"
      }
    ]
  }));

  const state = await readState();
  assert.deepEqual(state.settings, {
    profitTargetMultiplier: 1.4,
    stopLossMultiplier: 0.6,
    positionTimeoutMinutes: 120,
    buyAmountSol: 0.02
  });
  assert.equal(state.trackedTraders.length, 1);
  assert.equal(state.trackedTraders[0].enabled, true);
  assert.equal(state.activePositions.length, 1);
  assert.equal(state.activePositions[0].buyPlatform, "PumpSwap");
});

test("targeted state writes do not replace unrelated tables", async () => {
  const { addActivePosition, addTrackedTrader, readState, saveSettings } = await import("../state/store");

  await addTrackedTrader({
    address: "7XSuw2JPSn7zQbpSWcRnhFjjz6jA24XkZYYjMej8wD6E",
    enabled: true,
    createdAt: "2026-05-14T00:02:00.000Z"
  });
  await addActivePosition({
    id: "pos-2",
    tokenSymbol: "TOKEN2",
    tokenMint: "TokenMint2222222222222222222222222222222222",
    sourceTrader: "7XSuw2JPSn7zQbpSWcRnhFjjz6jA24XkZYYjMej8wD6E",
    buyPlatform: "Jupiter",
    buyTx: "buy-tx-2",
    entryPriceUsd: 0.02,
    currentPriceUsd: 0.02,
    amountUsd: 4,
    solSpent: 0.04,
    tokenAmount: 200,
    openedAt: "2026-05-14T00:03:00.000Z",
    status: "open"
  });
  await saveSettings({
    profitTargetMultiplier: 1.8,
    stopLossMultiplier: 0.5,
    positionTimeoutMinutes: 60,
    buyAmountSol: 0.01
  });

  const state = await readState();
  assert.equal(state.settings.profitTargetMultiplier, 1.8);
  assert.ok(state.trackedTraders.some((trader) => trader.address === "7XSuw2JPSn7zQbpSWcRnhFjjz6jA24XkZYYjMej8wD6E"));
  assert.ok(state.activePositions.some((position) => position.id === "pos-2"));
});
