/**
 * Jito Block Engine sender — for BUY paths only.
 *
 * Why: regular sendRawTransaction → leader-block landing ≈ 1-2 slots delay.
 * Jito bundles bid into a slot auction; with a tiny tip we land in the SAME
 * leader block as the trader's tx (or the next one), turning "5th wallet"
 * into "2-3rd wallet" on a copy-snipe.
 *
 * Cost: 50,000–200,000 lamports (~$0.004–$0.017 at $85/SOL) per landed bundle.
 * Tip cap is deliberately low — we don't compete with searchers who pay 0.01+ SOL
 * per bundle. We just want to beat regular RPC-send latency.
 *
 * Wire shape: POST `/api/v1/bundles` to mainnet Jito BE with a JSON-RPC
 * `sendBundle` call carrying an array of base58-encoded txs. Up to 5 txs per
 * bundle. We always send TWO txs: [tipTx, swapTx]. Keeping tip tx separate lets
 * us reuse pre-built swap txs (Jupiter returns a pre-signed tx — we can't
 * modify it).
 *
 * If Jito API errors or refuses the bundle, the caller catches and falls back
 * to regular RPC send (no tip, slower but always works).
 */
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";
import { createBotLog } from "./logs";
import { getCachedBlockhash } from "./caches/blockhashCache";

// Jito Block Engine mainnet endpoints (NY/AMS/Tokyo/FRA). Use NY by default —
// override via env when latency-tuning per geography.
const JITO_ENDPOINT =
  process.env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf";

// One of 8 official tip accounts. Bundle requires the tip transfer to land in
// one of these for the bundle to be accepted. Randomising spreads load.
const TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
  new PublicKey("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
  new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
  new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
  new PublicKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDe9B"),
  new PublicKey("ADuUkR4vqLUMWXxW9gh6D6L8pivKeVeZGvUDpKZmkjht"),
  new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
  new PublicKey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT")
];

// Tip clamps — keeps us cheap and predictable.
// Floor: 50,000 lamports = 0.00005 SOL ≈ $0.004
// Ceiling: 200,000 lamports = 0.0002 SOL ≈ $0.017
const TIP_MIN_LAMPORTS = Number(process.env.JITO_TIP_MIN_LAMPORTS) || 50_000;
const TIP_MAX_LAMPORTS = Number(process.env.JITO_TIP_MAX_LAMPORTS) || 200_000;
const TIP_FLOOR_URL =
  process.env.JITO_TIP_FLOOR_URL || "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
const TIP_FLOOR_TTL_MS = 30_000;

// Disable globally via env if Jito is down or we want a fallback-only fleet.
function isJitoEnabled(): boolean {
  return process.env.JITO_ENABLED !== "false";
}

type TipFloorEntry = {
  time?: string;
  landed_tips_25th_percentile?: number;
  landed_tips_50th_percentile?: number;
  landed_tips_75th_percentile?: number;
  landed_tips_95th_percentile?: number;
  landed_tips_99th_percentile?: number;
  ema_landed_tips_50th_percentile?: number;
};

let cachedTipLamports = TIP_MIN_LAMPORTS;
let lastTipFetchMs = 0;

/**
 * Pulls the 75th-percentile of landed tips for recent bundles, in lamports,
 * clamped to our [MIN, MAX]. Cached 30s — Jito's API isn't a hot path.
 * Falls back to MIN on any failure so we still bundle (with cheap tip) rather
 * than skipping Jito entirely.
 */
async function getDynamicTipLamports(): Promise<number> {
  const now = Date.now();
  if (now - lastTipFetchMs < TIP_FLOOR_TTL_MS) {
    return cachedTipLamports;
  }
  try {
    const response = await fetch(TIP_FLOOR_URL);
    if (!response.ok) throw new Error(`tip_floor HTTP ${response.status}`);
    const data = (await response.json()) as TipFloorEntry[] | TipFloorEntry;
    const latest = Array.isArray(data) ? data[data.length - 1] || data[0] : data;
    const tipSol =
      latest?.landed_tips_75th_percentile ??
      latest?.landed_tips_50th_percentile ??
      0.00005;
    const lamports = Math.floor(tipSol * 1e9);
    cachedTipLamports = Math.min(TIP_MAX_LAMPORTS, Math.max(TIP_MIN_LAMPORTS, lamports));
    lastTipFetchMs = now;
  } catch {
    // tip_floor unavailable → keep cached, refresh next interval
    cachedTipLamports = Math.max(TIP_MIN_LAMPORTS, cachedTipLamports);
  }
  return cachedTipLamports;
}

function pickTipAccount(): PublicKey {
  return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
}

/**
 * Build a tiny signed tip transaction (one SystemProgram.transfer ix).
 * Separate tx, not appended to the swap — keeps swap tx pre-built/signed by
 * Jupiter et al usable without touching its byte layout.
 */
function buildTipTx(
  wallet: Keypair,
  tipLamports: number,
  blockhash: string,
  lastValidBlockHeight: number
): Transaction {
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: pickTipAccount(),
      lamports: tipLamports
    })
  );
  tx.sign(wallet);
  return tx;
}

function getSwapSignature(swapTx: Transaction | VersionedTransaction): string {
  if (swapTx instanceof VersionedTransaction) {
    const sig = swapTx.signatures[0];
    if (!sig) throw new Error("Swap VersionedTransaction not signed");
    return bs58.encode(sig);
  }
  const sig = swapTx.signature;
  if (!sig) throw new Error("Swap Transaction not signed");
  return bs58.encode(sig);
}

function serializeForBundle(swapTx: Transaction | VersionedTransaction): Uint8Array {
  // VerifySignatures false because Jito verifies on its side anyway, and Jupiter
  // sometimes produces txs where our local SDK can't verify due to signer order.
  if (swapTx instanceof VersionedTransaction) {
    return swapTx.serialize();
  }
  return swapTx.serialize({ verifySignatures: false });
}

/**
 * POST the bundle to Jito BE and return the bundle UUID. The caller still does
 * a regular Solana confirmTransaction on the swap signature to wait for landing.
 */
async function postBundle(base58Txs: string[]): Promise<string> {
  const response = await fetch(`${JITO_ENDPOINT}/api/v1/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [base58Txs]
    })
  });
  if (!response.ok) {
    throw new Error(`Jito sendBundle HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  }
  const data = (await response.json()) as { result?: string; error?: { message?: string } };
  if (data.error) {
    throw new Error(`Jito sendBundle error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  if (!data.result) {
    throw new Error("Jito sendBundle returned no bundle ID");
  }
  return data.result;
}

/**
 * Bundle a signed swap tx with a tip tx and ship to Jito. Returns the swap's
 * signature — caller uses it for confirmTransaction as usual.
 *
 * Throws on any failure so the caller can fall back to plain RPC send.
 */
export async function sendBuyViaJito(
  connection: Connection,
  wallet: Keypair,
  swapTx: Transaction | VersionedTransaction,
  /** Token mint, used only for the BUY_TIMING / BUY_JITO log metadata. */
  tokenMint?: string
): Promise<{ signature: string; bundleId: string; tipLamports: number }> {
  if (!isJitoEnabled()) {
    throw new Error("Jito disabled (JITO_ENABLED=false)");
  }
  const tipLamports = await getDynamicTipLamports();

  // Tip tx must use the SAME blockhash window as the swap (Jito bundles require
  // all txs to have valid recent blockhashes). Cached blockhash is fresh ≤8s.
  const { blockhash, lastValidBlockHeight } = await getCachedBlockhash(connection);
  const tipTx = buildTipTx(wallet, tipLamports, blockhash, lastValidBlockHeight);

  const tipB58 = bs58.encode(tipTx.serialize());
  const swapB58 = bs58.encode(serializeForBundle(swapTx));

  const bundleId = await postBundle([tipB58, swapB58]);
  const signature = getSwapSignature(swapTx);

  createBotLog({
    event: "BUY_JITO_BUNDLE_SENT",
    message: `Bundle ${bundleId.slice(0, 12)}… for ${tokenMint?.slice(0, 8) ?? "?"} tip=${tipLamports} lamports`,
    tokenMint,
    signature,
    metadata: { bundleId, tipLamports, tipSol: tipLamports / 1e9 }
  });

  return { signature, bundleId, tipLamports };
}
