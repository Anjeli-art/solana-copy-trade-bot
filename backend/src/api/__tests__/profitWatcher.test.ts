import test from "node:test";
import assert from "node:assert/strict";
import { getPositionCloseSignal } from "../services/positionRules";

test("getPositionCloseSignal returns take-profit when target is reached", () => {
  assert.equal(getPositionCloseSignal(1.4, 1.4, 0.7), "take-profit");
  assert.equal(getPositionCloseSignal(2, 1.4, 0.7), "take-profit");
});

test("getPositionCloseSignal returns stop-loss when drawdown is reached", () => {
  assert.equal(getPositionCloseSignal(0.7, 1.4, 0.7), "stop-loss");
  assert.equal(getPositionCloseSignal(0.3, 1.4, 0.7), "stop-loss");
});

test("getPositionCloseSignal ignores stop-loss when disabled", () => {
  assert.equal(getPositionCloseSignal(0.3, 1.4, 0), null);
});

test("getPositionCloseSignal keeps position open inside the band", () => {
  assert.equal(getPositionCloseSignal(1, 1.4, 0.7), null);
});

test("getPositionCloseSignal returns timeout when position age exceeds timeout", () => {
  assert.equal(getPositionCloseSignal(1, 1.4, 0.7, 120 * 60 * 1000, 120), "timeout");
  assert.equal(getPositionCloseSignal(1, 1.4, 0.7, 119 * 60 * 1000, 120), null);
});

test("getPositionCloseSignal ignores timeout when disabled", () => {
  assert.equal(getPositionCloseSignal(1, 1.4, 0.7, 1000 * 60 * 1000, 0), null);
});
