import test from "node:test";
import assert from "node:assert/strict";
import { buildMintSafetyFindings, buildQuoteSafetyFindings } from "../services/tokenSafety";

test("buildMintSafetyFindings flags freeze and mint authorities", () => {
  const findings = buildMintSafetyFindings({
    mintAuthority: "MintAuthority111111111111111111111111111111",
    freezeAuthority: "FreezeAuthority1111111111111111111111111111"
  });

  assert.deepEqual(
    findings.map((finding) => finding.type),
    ["freeze-authority", "mint-authority"]
  );
});

test("buildMintSafetyFindings flags token-2022 transfer fee extension", () => {
  const findings = buildMintSafetyFindings({
    mintOwner: "TokenzQdBNbLqP5VEhdkAS6EPF7v9zKfRSJw4JkEYH",
    extensions: [{ extension: "transferFeeConfig" }]
  });

  assert.deepEqual(
    findings.map((finding) => finding.type),
    ["token-2022", "token-2022-transfer-fee"]
  );
});

test("buildQuoteSafetyFindings flags missing sell route as honeypot risk", () => {
  const result = buildQuoteSafetyFindings({
    amountSol: 0.03,
    buyQuote: {
      outAmount: "1000000"
    },
    sellQuoteError: "No route found"
  });

  assert.equal(result.findings[0].type, "sell-route-unavailable");
});

test("buildQuoteSafetyFindings flags high round-trip loss", () => {
  const result = buildQuoteSafetyFindings({
    amountSol: 1,
    buyQuote: {
      outAmount: "1000000"
    },
    sellQuote: {
      outAmount: "500000000"
    }
  });

  assert.equal(result.roundTripLossPct, 50);
  assert.equal(result.findings[0].type, "high-roundtrip-loss");
});

test("buildQuoteSafetyFindings flags high price impact", () => {
  const result = buildQuoteSafetyFindings({
    amountSol: 1,
    buyQuote: {
      outAmount: "1000000",
      priceImpactPct: "12"
    },
    sellQuote: {
      outAmount: "980000000"
    }
  });

  assert.equal(result.findings.some((finding) => finding.type === "high-price-impact"), true);
});
