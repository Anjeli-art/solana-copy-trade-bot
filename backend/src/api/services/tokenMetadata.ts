import path from "path";
import dotenv from "dotenv";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { db } from "../db/sqlite";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();

export type TokenMetadata = {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  decimals?: number;
  isToken2022: boolean;
  source: "helius";
  fetchedAt: string;
};

type TokenMetadataRow = {
  mint: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  decimals: number | null;
  is_token_2022: number;
  fetched_at: string;
};

type HeliusAsset = {
  interface?: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
    links?: {
      image?: string;
    };
    files?: Array<{
      uri?: string;
      mime?: string;
    }>;
  };
  token_info?: {
    decimals?: number;
    token_program?: string;
    tokenProgram?: string;
  };
  mint_extensions?: {
    token_program?: string;
    tokenProgram?: string;
  };
};

type HeliusResponse = {
  result?: HeliusAsset;
  error?: {
    message?: string;
  };
};

function getHeliusEndpoint() {
  return process.env.MAINNET_ENDPOINT || process.env.RPC_ENDPOINT || "";
}

function toMetadata(row: TokenMetadataRow): TokenMetadata {
  return {
    mint: row.mint,
    name: row.name || undefined,
    symbol: row.symbol || undefined,
    image: row.image || undefined,
    decimals: row.decimals ?? undefined,
    isToken2022: row.is_token_2022 === 1,
    source: "helius",
    fetchedAt: row.fetched_at
  };
}

function getCachedMetadata(mint: string) {
  const row = db
    .prepare("SELECT mint, name, symbol, image, decimals, is_token_2022, fetched_at FROM token_metadata WHERE mint = ?")
    .get(mint) as TokenMetadataRow | undefined;

  return row ? toMetadata(row) : undefined;
}

function isCacheFresh(metadata: TokenMetadata) {
  return Date.now() - Date.parse(metadata.fetchedAt) < CACHE_TTL_MS;
}

function getImage(asset: HeliusAsset) {
  const directImage = asset.content?.links?.image;
  if (directImage) return directImage;

  return asset.content?.files?.find((file) => file.mime?.startsWith("image/") && file.uri)?.uri;
}

function isToken2022(asset: HeliusAsset) {
  const tokenProgram = asset.token_info?.token_program
    || asset.token_info?.tokenProgram
    || asset.mint_extensions?.token_program
    || asset.mint_extensions?.tokenProgram;

  return tokenProgram === TOKEN_2022_PROGRAM || asset.interface === "FungibleToken2022";
}

async function fetchHeliusMetadata(mint: string) {
  const cached = getCachedMetadata(mint);
  const endpoint = getHeliusEndpoint();
  if (!endpoint) {
    throw new Error("MAINNET_ENDPOINT or RPC_ENDPOINT is required for token metadata");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "token-metadata",
      method: "getAsset",
      params: {
        id: mint
      }
    })
  });
  const payload = await response.json().catch(() => ({})) as HeliusResponse;

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error?.message || `Helius metadata request failed: ${response.status}`);
  }

  const asset = payload.result;
  const fetchedAt = new Date().toISOString();

  const metadata: TokenMetadata = {
    mint,
    name: asset.content?.metadata?.name,
    symbol: asset.content?.metadata?.symbol,
    image: getImage(asset) || cached?.image,
    decimals: asset.token_info?.decimals,
    isToken2022: isToken2022(asset),
    source: "helius",
    fetchedAt
  };

  db.prepare(
    `
      INSERT INTO token_metadata (
        mint, name, symbol, image, decimals, is_token_2022, raw_metadata, fetched_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET
        name = excluded.name,
        symbol = excluded.symbol,
        image = excluded.image,
        decimals = excluded.decimals,
        is_token_2022 = excluded.is_token_2022,
        raw_metadata = excluded.raw_metadata,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `
  ).run(
    mint,
    metadata.name || null,
    metadata.symbol || null,
    metadata.image || null,
    metadata.decimals ?? null,
    metadata.isToken2022 ? 1 : 0,
    JSON.stringify(asset),
    fetchedAt,
    fetchedAt
  );

  return metadata;
}

export async function getTokenMetadata(mint: string) {
  const cached = getCachedMetadata(mint);
  if (cached && isCacheFresh(cached)) {
    return cached;
  }

  try {
    return await fetchHeliusMetadata(mint);
  } catch (error) {
    if (cached) {
      return cached;
    }
    throw error;
  }
}
