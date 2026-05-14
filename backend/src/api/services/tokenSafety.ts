import { PublicKey } from "@solana/web3.js";
import { getRaydiumConnection } from "./raydiumSwap";
import {
  getJupiterQuote,
  rawToUiAmount,
  toRawAmount,
  type JupiterQuote
} from "./jupiterSwap";
import { createBotLog } from "./logs";
import { WSOL_MINT } from "../platforms/platformDetector";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPF7v9zKfRSJw4JkEYH";
const HIGH_ROUND_TRIP_LOSS_PCT = 30;
const TAX_OR_LIQUIDITY_LOSS_PCT = 10;
const HIGH_PRICE_IMPACT_PCT = 10;

export type TokenSafetyFindingType =
  | "freeze-authority"
  | "mint-authority"
  | "token-2022"
  | "token-2022-transfer-fee"
  | "buy-route-unavailable"
  | "sell-route-unavailable"
  | "high-roundtrip-loss"
  | "tax-or-liquidity-risk"
  | "high-price-impact";

export type TokenSafetyFinding = {
  type: TokenSafetyFindingType;
  severity: "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
};

export type TokenSafetyReport = {
  tokenMint: string;
  checkedAt: string;
  mintOwner?: string;
  isToken2022: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  token2022Extensions?: string[];
  buyQuoteOutAmount?: string;
  sellQuoteOutSol?: number;
  roundTripLossPct?: number;
  buyPriceImpactPct?: number;
  sellPriceImpactPct?: number;
  findings: TokenSafetyFinding[];
};

type ParsedMintSafetyInput = {
  mintOwner?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  extensions?: unknown[];
};

type QuoteSafetyInput = {
  amountSol: number;
  buyQuote?: JupiterQuote;
  sellQuote?: JupiterQuote;
  buyQuoteError?: string;
  sellQuoteError?: string;
};

function extensionName(extension: unknown) {
  if (!extension || typeof extension !== "object") {
    return "";
  }

  const value = extension as Record<string, unknown>;
  return String(value.extension || value.extensionType || value.type || "");
}

function parsePriceImpactPct(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactFindings(findings: TokenSafetyFinding[]) {
  return findings.map((finding) => finding.type).join(", ");
}

export function buildMintSafetyFindings(input: ParsedMintSafetyInput) {
  const findings: TokenSafetyFinding[] = [];
  const extensions = (input.extensions || []).map(extensionName).filter(Boolean);

  if (input.freezeAuthority) {
    findings.push({
      type: "freeze-authority",
      severity: "warn",
      message: "Token mint has freeze authority. Creator can freeze token accounts.",
      metadata: {
        freezeAuthority: input.freezeAuthority
      }
    });
  }

  if (input.mintAuthority) {
    findings.push({
      type: "mint-authority",
      severity: "warn",
      message: "Token mint has mint authority. Creator can mint more supply.",
      metadata: {
        mintAuthority: input.mintAuthority
      }
    });
  }

  if (input.mintOwner === TOKEN_2022_PROGRAM_ID) {
    findings.push({
      type: "token-2022",
      severity: "warn",
      message: "Token uses Token-2022 program. It can include transfer fees or custom restrictions.",
      metadata: {
        mintOwner: input.mintOwner,
        extensions
      }
    });
  }

  const transferFeeExtensions = extensions.filter((name) => name.toLowerCase().includes("transferfee"));
  if (transferFeeExtensions.length > 0) {
    findings.push({
      type: "token-2022-transfer-fee",
      severity: "warn",
      message: "Token-2022 transfer fee extension detected.",
      metadata: {
        extensions: transferFeeExtensions
      }
    });
  }

  return findings;
}

export function buildQuoteSafetyFindings(input: QuoteSafetyInput) {
  const findings: TokenSafetyFinding[] = [];
  const buyPriceImpactPct = parsePriceImpactPct(input.buyQuote?.priceImpactPct);
  const sellPriceImpactPct = parsePriceImpactPct(input.sellQuote?.priceImpactPct);
  const sellQuoteOutSol = rawToUiAmount(input.sellQuote?.outAmount, 9);
  const roundTripLossPct =
    input.amountSol > 0 && input.sellQuote?.outAmount
      ? Math.max(0, ((input.amountSol - sellQuoteOutSol) / input.amountSol) * 100)
      : undefined;

  if (input.buyQuoteError || !input.buyQuote?.outAmount || Number(input.buyQuote.outAmount) <= 0) {
    findings.push({
      type: "buy-route-unavailable",
      severity: "error",
      message: "Jupiter could not build a buy quote for this token.",
      metadata: {
        error: input.buyQuoteError
      }
    });
  }

  if (input.sellQuoteError || (input.buyQuote?.outAmount && (!input.sellQuote?.outAmount || Number(input.sellQuote.outAmount) <= 0))) {
    findings.push({
      type: "sell-route-unavailable",
      severity: "error",
      message: "Jupiter could not build a sell quote after simulated buy amount. Honeypot risk.",
      metadata: {
        error: input.sellQuoteError,
        buyQuoteOutAmount: input.buyQuote?.outAmount
      }
    });
  }

  if (roundTripLossPct !== undefined && roundTripLossPct >= HIGH_ROUND_TRIP_LOSS_PCT) {
    findings.push({
      type: "high-roundtrip-loss",
      severity: "warn",
      message: "Round-trip quote loss is very high. Token may have tax, poor liquidity, or honeypot-like behavior.",
      metadata: {
        roundTripLossPct,
        sellQuoteOutSol
      }
    });
  } else if (roundTripLossPct !== undefined && roundTripLossPct >= TAX_OR_LIQUIDITY_LOSS_PCT) {
    findings.push({
      type: "tax-or-liquidity-risk",
      severity: "warn",
      message: "Round-trip quote loss is elevated. Possible tax, wide spread, or weak liquidity.",
      metadata: {
        roundTripLossPct,
        sellQuoteOutSol
      }
    });
  }

  const highPriceImpact = Math.max(buyPriceImpactPct || 0, sellPriceImpactPct || 0);
  if (highPriceImpact >= HIGH_PRICE_IMPACT_PCT) {
    findings.push({
      type: "high-price-impact",
      severity: "warn",
      message: "Jupiter quote has high price impact.",
      metadata: {
        buyPriceImpactPct,
        sellPriceImpactPct
      }
    });
  }

  return {
    findings,
    buyPriceImpactPct,
    sellPriceImpactPct,
    sellQuoteOutSol,
    roundTripLossPct
  };
}

async function inspectMint(tokenMint: string) {
  const connection = getRaydiumConnection();
  const account = await connection.getParsedAccountInfo(new PublicKey(tokenMint), "confirmed");
  const mintOwner = account.value?.owner.toBase58();
  const parsedData = account.value?.data as any;
  const info = parsedData?.parsed?.info || {};
  const extensions = Array.isArray(info.extensions) ? info.extensions : [];

  return {
    mintOwner,
    isToken2022: mintOwner === TOKEN_2022_PROGRAM_ID || parsedData?.program === "spl-token-2022",
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    token2022Extensions: extensions.map(extensionName).filter(Boolean),
    findings: buildMintSafetyFindings({
      mintOwner,
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions
    })
  };
}

async function inspectQuotes(tokenMint: string, amountSol: number) {
  let buyQuote: JupiterQuote | undefined;
  let sellQuote: JupiterQuote | undefined;
  let buyQuoteError: string | undefined;
  let sellQuoteError: string | undefined;

  try {
    buyQuote = await getJupiterQuote({
      inputMint: WSOL_MINT,
      outputMint: tokenMint,
      amount: toRawAmount(amountSol, 9)
    });
  } catch (error) {
    buyQuoteError = error instanceof Error ? error.message : "Unknown buy quote error";
  }

  if (buyQuote?.outAmount && Number(buyQuote.outAmount) > 0) {
    try {
      sellQuote = await getJupiterQuote({
        inputMint: tokenMint,
        outputMint: WSOL_MINT,
        amount: buyQuote.outAmount
      });
    } catch (error) {
      sellQuoteError = error instanceof Error ? error.message : "Unknown sell quote error";
    }
  }

  const quoteSafety = buildQuoteSafetyFindings({
    amountSol,
    buyQuote,
    sellQuote,
    buyQuoteError,
    sellQuoteError
  });

  return {
    buyQuoteOutAmount: buyQuote?.outAmount,
    sellQuoteOutSol: quoteSafety.sellQuoteOutSol,
    roundTripLossPct: quoteSafety.roundTripLossPct,
    buyPriceImpactPct: quoteSafety.buyPriceImpactPct,
    sellPriceImpactPct: quoteSafety.sellPriceImpactPct,
    findings: quoteSafety.findings
  };
}

export async function inspectTokenSafety(tokenMint: string, amountSol: number): Promise<TokenSafetyReport> {
  const mint = await inspectMint(tokenMint);
  const quotes = await inspectQuotes(tokenMint, amountSol);

  return {
    tokenMint,
    checkedAt: new Date().toISOString(),
    mintOwner: mint.mintOwner || TOKEN_PROGRAM_ID,
    isToken2022: mint.isToken2022,
    mintAuthority: mint.mintAuthority,
    freezeAuthority: mint.freezeAuthority,
    token2022Extensions: mint.token2022Extensions,
    buyQuoteOutAmount: quotes.buyQuoteOutAmount,
    sellQuoteOutSol: quotes.sellQuoteOutSol,
    roundTripLossPct: quotes.roundTripLossPct,
    buyPriceImpactPct: quotes.buyPriceImpactPct,
    sellPriceImpactPct: quotes.sellPriceImpactPct,
    findings: [...mint.findings, ...quotes.findings]
  };
}

export async function logTokenSafetyBeforeBuy(input: {
  tokenMint: string;
  amountSol: number;
  trader?: string;
  signature?: string;
  source?: "copy-trade" | "manual";
}) {
  try {
    const report = await inspectTokenSafety(input.tokenMint, input.amountSol);
    if (report.findings.length === 0) {
      return report;
    }

    createBotLog({
      level: "warn",
      event: "TOKEN_SAFETY_WARNING",
      message: `Token safety warning before buy: ${compactFindings(report.findings)}`,
      trader: input.trader,
      tokenMint: input.tokenMint,
      signature: input.signature,
      metadata: {
        source: input.source || "copy-trade",
        amountSol: input.amountSol,
        report
      }
    });

    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown token safety check error";
    createBotLog({
      level: "warn",
      event: "TOKEN_SAFETY_CHECK_FAILED",
      message: `Token safety check failed before buy: ${message}`,
      trader: input.trader,
      tokenMint: input.tokenMint,
      signature: input.signature,
      metadata: {
        source: input.source || "copy-trade",
        amountSol: input.amountSol
      }
    });
    return undefined;
  }
}
