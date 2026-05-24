import test from "node:test";
import assert from "node:assert/strict";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { detectTraderPlatformBuys, WSOL_MINT } from "../platforms/platformDetector";

const TRADER = "3jSHyFJjkWnz73niuzRnjsxSEA6MV3kwKu4ZAFEXGN6f";
const TOKEN_MINT = "TokenMint1111111111111111111111111111111111";

function account(pubkey: string) {
  return {
    pubkey: {
      toBase58: () => pubkey
    }
  };
}

function tokenBalance(owner: string, mint: string, uiAmount: number) {
  return {
    owner,
    mint,
    uiTokenAmount: {
      uiAmount,
      amount: String(Math.round(uiAmount * 1_000_000)),
      decimals: 6
    }
  };
}

function transaction(programId: string, options?: { solDelta?: number; wsolPre?: number; wsolPost?: number; tokenPre?: number; tokenPost?: number }) {
  const solDelta = options?.solDelta ?? -0.25;
  const wsolPre = options?.wsolPre ?? 0;
  const wsolPost = options?.wsolPost ?? 0;
  const tokenPre = options?.tokenPre ?? 0;
  const tokenPost = options?.tokenPost ?? 100;

  return {
    slot: 10,
    blockTime: 1710000000,
    transaction: {
      message: {
        accountKeys: [account(TRADER), account(programId)]
      }
    },
    meta: {
      preBalances: [1 * LAMPORTS_PER_SOL, 0],
      postBalances: [(1 + solDelta) * LAMPORTS_PER_SOL, 0],
      preTokenBalances: [tokenBalance(TRADER, TOKEN_MINT, tokenPre), tokenBalance(TRADER, WSOL_MINT, wsolPre)],
      postTokenBalances: [tokenBalance(TRADER, TOKEN_MINT, tokenPost), tokenBalance(TRADER, WSOL_MINT, wsolPost)]
    }
  };
}

test("detectTraderPlatformBuys detects Raydium buys from SOL spend and token increase", () => {
  const buys = detectTraderPlatformBuys(
    transaction("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    TRADER,
    "sig-raydium",
    100
  );

  assert.equal(buys.length, 1);
  assert.equal(buys[0].platform, "Raydium");
  assert.equal(buys[0].tokenMint, TOKEN_MINT);
  assert.equal(buys[0].tokenAmount, 100);
  assert.equal(buys[0].spentSol, 0.25);
  assert.equal(buys[0].traderEntryPriceUsd, 0.25);
});

test("detectTraderPlatformBuys detects all configured platform program ids", () => {
  const cases = [
    ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "Raydium"],
    ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium"],
    ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca"],
    ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Meteora"],
    ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "Pump.fun"],
    ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "PumpSwap"],
    ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter"]
  ] as const;

  for (const [programId, platform] of cases) {
    const buys = detectTraderPlatformBuys(transaction(programId), TRADER, `sig-${platform}`, 90);
    assert.equal(buys.length, 1);
    assert.equal(buys[0].platform, platform);
  }
});

test("detectTraderPlatformBuys ignores airdrops and transfers without spend", () => {
  const buys = detectTraderPlatformBuys(
    transaction("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", { solDelta: 0 }),
    TRADER,
    "sig-airdrop",
    100
  );

  assert.equal(buys.length, 0);
});

test("detectTraderPlatformBuys ignores token decreases and unrelated programs", () => {
  assert.equal(
    detectTraderPlatformBuys(
      transaction("11111111111111111111111111111111", { tokenPre: 0, tokenPost: 100 }),
      TRADER,
      "sig-unrelated",
      100
    ).length,
    0
  );
  assert.equal(
    detectTraderPlatformBuys(
      transaction("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", { tokenPre: 100, tokenPost: 50 }),
      TRADER,
      "sig-sell",
      100
    ).length,
    0
  );
});
