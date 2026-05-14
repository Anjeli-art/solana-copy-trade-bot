import test from "node:test";
import assert from "node:assert/strict";
import { isPositiveNumber, isSolanaAddress, normalizeLabel } from "../validation";

test("isSolanaAddress accepts base58 wallet-like strings", () => {
  assert.equal(isSolanaAddress("5D1Xh1muXsdp6dPdAJWPvSgXo7nDJUwQxbsj5VY3HgJd"), true);
});

test("isSolanaAddress rejects malformed values", () => {
  assert.equal(isSolanaAddress(""), false);
  assert.equal(isSolanaAddress("0D1Xh1muXsdp6dPdAJWPvSgXo7nDJUwQxbsj5VY3HgJd"), false);
  assert.equal(isSolanaAddress("short"), false);
  assert.equal(isSolanaAddress(123), false);
});

test("isPositiveNumber only accepts finite positive numbers", () => {
  assert.equal(isPositiveNumber(0.033), true);
  assert.equal(isPositiveNumber(0), false);
  assert.equal(isPositiveNumber(-1), false);
  assert.equal(isPositiveNumber(Number.NaN), false);
  assert.equal(isPositiveNumber("0.033"), false);
});

test("normalizeLabel trims and limits labels", () => {
  assert.equal(normalizeLabel("  trader one  "), "trader one");
  assert.equal(normalizeLabel(""), undefined);
  assert.equal(normalizeLabel(undefined), undefined);
  assert.equal(normalizeLabel("x".repeat(100)), "x".repeat(64));
});
