import assert from "node:assert/strict";
import test from "node:test";
import { filterClosedPositions, getPnl } from "../src/utils/positions.ts";

function closedPosition(id: string, closedAt: string) {
  return {
    id,
    tokenSymbol: "TEST",
    tokenMint: "TestMint11111111111111111111111111111111",
    platform: "PumpSwap",
    entryPrice: 10,
    currentPrice: 12,
    amountUsd: 200,
    tokenAmount: 20,
    trader: "Trader1111111111111111111111111111111111",
    openedAt: "2026-05-21T10:00:00.000Z",
    exitPrice: 12,
    exitPlatform: "Jupiter",
    closedAt,
    closeReason: "manual",
    sellTx: "SellTx11111111111111111111111111111111111"
  };
}

test("getPnl calculates percentage and USD profit from entry/current price", () => {
  const pnl = getPnl({
    entryPrice: 10,
    currentPrice: 12.5,
    amountUsd: 200
  });

  assert.equal(pnl.pnlPercent, 25);
  assert.equal(pnl.pnlUsd, 50);
});

test("filterClosedPositions keeps custom date range inclusive", () => {
  const positions = [
    closedPosition("before", new Date(2026, 4, 20, 23, 59, 59).toISOString()),
    closedPosition("inside", new Date(2026, 4, 21, 12, 0, 0).toISOString()),
    closedPosition("after", new Date(2026, 4, 22, 0, 0, 1).toISOString())
  ];

  const result = filterClosedPositions(positions, "custom", "2026-05-21", "2026-05-21");

  assert.deepEqual(
    result.map((position) => position.id),
    ["inside"]
  );
});

test("filterClosedPositions returns all rows for all filter", () => {
  const positions = [
    closedPosition("one", "2026-05-20T10:00:00.000Z"),
    closedPosition("two", "2026-05-21T10:00:00.000Z")
  ];

  assert.equal(filterClosedPositions(positions, "all", "", "").length, 2);
});
