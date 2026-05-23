import assert from "node:assert/strict";
import test from "node:test";
import { exportAnalyticsToExcel } from "../src/utils/analyticsExport.ts";

function traderAnalytics(overrides = {}) {
  return {
    trader: "Trader111111111111111111111111111111111",
    label: "Alpha \"Desk\"",
    tradeCount: 3,
    activeTradeCount: 1,
    closedTradeCount: 2,
    totalAmountUsd: 42.5,
    totalSolSpent: 0.48,
    realizedPnlUsd: 5.25,
    unrealizedPnlUsd: -1.25,
    totalPnlUsd: 4,
    totalPnlPercent: 9.4117,
    winCount: 1,
    lossCount: 1,
    winRate: 50,
    averagePnlUsd: 2,
    firstTradeAt: "2026-05-21T10:00:00.000Z",
    lastTradeAt: "2026-05-22T10:00:00.000Z",
    ...overrides
  };
}

function manualTokenAnalytics(overrides = {}) {
  return {
    tokenMint: "TokenMint11111111111111111111111111111111",
    tokenSymbol: "TOK",
    tokenName: "Token, With Comma",
    tokenImage: "",
    tradeCount: 2,
    activeTradeCount: 0,
    closedTradeCount: 2,
    totalAmountUsd: 20,
    totalSolSpent: 0.2,
    realizedPnlUsd: -3,
    unrealizedPnlUsd: 0,
    totalPnlUsd: -3,
    totalPnlPercent: -15,
    winCount: 0,
    lossCount: 2,
    winRate: 0,
    averagePnlUsd: -1.5,
    firstTradeAt: "2026-05-20T10:00:00.000Z",
    lastTradeAt: "2026-05-21T10:00:00.000Z",
    ...overrides
  };
}

function mockDownload(t: test.TestContext) {
  const originalDocument = globalThis.document;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const download = {
    blob: undefined as Blob | undefined,
    filename: "",
    clicked: false
  };

  globalThis.document = {
    createElement(tagName: string) {
      assert.equal(tagName, "a");
      return {
        href: "",
        download: "",
        click() {
          download.clicked = true;
          download.filename = this.download;
        }
      };
    }
  } as any;
  URL.createObjectURL = ((blob: Blob) => {
    download.blob = blob;
    return "blob:analytics-export";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    assert.equal(url, "blob:analytics-export");
  }) as typeof URL.revokeObjectURL;

  t.after(() => {
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  return download;
}

test("exportAnalyticsToExcel downloads trading analytics as Excel-friendly CSV", async (t) => {
  const download = mockDownload(t);

  exportAnalyticsToExcel([traderAnalytics()], [], "trading");

  assert.equal(download.clicked, true);
  assert.equal(download.filename, "trader-analytics.csv");
  assert.equal(download.blob?.type, "text/csv;charset=utf-8;");

  const bytes = new Uint8Array(await download.blob!.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);

  const text = await download.blob!.text();
  assert.match(text, /"Trader","Label","Trades"/);
  assert.match(text, /"Trader111111111111111111111111111111111","Alpha ""Desk""","3"/);
  assert.match(text, /"9.41"/);
});

test("exportAnalyticsToExcel downloads manual token analytics as Excel-friendly CSV", async (t) => {
  const download = mockDownload(t);

  exportAnalyticsToExcel([], [manualTokenAnalytics()], "manual");

  assert.equal(download.clicked, true);
  assert.equal(download.filename, "manual-token-analytics.csv");

  const text = await download.blob!.text();
  assert.match(text, /"Token","Symbol","Mint"/);
  assert.match(text, /"Token, With Comma","TOK","TokenMint11111111111111111111111111111111"/);
  assert.match(text, /"-15.00"/);
});
