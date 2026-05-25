import path from "path";
import dotenv from "dotenv";
import bs58 from "bs58";
import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  MAINNET_PROGRAM_ID,
  MARKET_STATE_LAYOUT_V3,
  Market,
  Percent,
  SPL_MINT_LAYOUT,
  Token,
  TOKEN_PROGRAM_ID,
  TokenAmount,
  publicKey,
  struct
} from "@raydium-io/raydium-sdk";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT
} from "@solana/spl-token";
import { BN } from "@project-serum/anchor";
import { Decimal } from "decimal.js";

dotenv.config({
  path: path.resolve(__dirname, "../../helpers/.env")
});

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const MINIMAL_MARKET_STATE_LAYOUT_V3 = struct([publicKey("eventQueue"), publicKey("bids"), publicKey("asks")]);
const poolCache = new Map<string, string>();
const decimalsCache = new Map<string, number>();

type SwapSide = "buy" | "sell";

type RaydiumSwapResult = {
  tokenMint: string;
  side: SwapSide;
  poolId: string;
  signature?: string;
  tokenAmountDelta?: number;
};

type RaydiumPoolListItem = {
  id?: string;
  type?: string;
};

type RaydiumPoolListResponse = {
  data?: RaydiumPoolListItem[];
};

type DecimalLike = {
  toString: () => string;
};

function getRpcEndpoint() {
  return process.env.MAINNET_ENDPOINT || process.env.RPC_ENDPOINT || "";
}

export function getRaydiumConnection() {
  const endpoint = getRpcEndpoint();
  if (!endpoint) {
    throw new Error("MAINNET_ENDPOINT or RPC_ENDPOINT is required for Raydium swaps");
  }

  return new Connection(endpoint, "confirmed");
}

export function getTradingWallet() {
  const privateKey = process.env.PRIVATE_KEY || "";
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is required for Raydium swaps");
  }

  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

async function getTokenDecimals(connection: Connection, mint: PublicKey) {
  const cacheKey = mint.toBase58();
  const cached = decimalsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const account = await connection.getAccountInfo(mint);
  if (!account) {
    throw new Error(`Token mint not found: ${cacheKey}`);
  }

  const decimals = SPL_MINT_LAYOUT.decode(account.data).decimals;
  decimalsCache.set(cacheKey, decimals);
  return decimals;
}

async function formatAmmKeysById(connection: Connection, id: PublicKey) {
  const account = await connection.getAccountInfo(id);
  if (!account) {
    throw new Error(`Raydium AMM pool not found: ${id.toBase58()}`);
  }

  const info = LIQUIDITY_STATE_LAYOUT_V4.decode(account.data);
  const marketAccountMinimal = await connection.getAccountInfo(info.marketId, {
    commitment: "processed",
    dataSlice: {
      offset: MARKET_STATE_LAYOUT_V3.offsetOf("eventQueue"),
      length: 32 * 3
    }
  });
  const marketAccount = await connection.getAccountInfo(info.marketId);

  if (!marketAccount || !marketAccountMinimal) {
    throw new Error(`Raydium market not found for pool: ${id.toBase58()}`);
  }

  const marketInfoMinimal = MINIMAL_MARKET_STATE_LAYOUT_V3.decode(marketAccountMinimal.data);
  const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);

  return {
    id,
    baseMint: info.baseMint,
    quoteMint: info.quoteMint,
    lpMint: info.lpMint,
    baseDecimals: info.baseDecimal.toNumber(),
    quoteDecimals: info.quoteDecimal.toNumber(),
      lpDecimals: 5,
      version: 4 as const,
    programId: MAINNET_PROGRAM_ID.AmmV4,
    authority: Liquidity.getAssociatedAuthority({ programId: MAINNET_PROGRAM_ID.AmmV4 }).publicKey,
    openOrders: info.openOrders,
    targetOrders: info.targetOrders,
    baseVault: info.baseVault,
    quoteVault: info.quoteVault,
      marketVersion: 3 as const,
    marketProgramId: info.marketProgramId,
    marketId: info.marketId,
    marketAuthority: Market.getAssociatedAuthority({
      programId: info.marketProgramId,
      marketId: info.marketId
    }).publicKey,
    marketBaseVault: marketInfo.baseVault,
    marketQuoteVault: marketInfo.quoteVault,
    marketBids: marketInfoMinimal.bids,
    marketAsks: marketInfoMinimal.asks,
    marketEventQueue: marketInfoMinimal.eventQueue,
    withdrawQueue: info.withdrawQueue,
    lpVault: info.lpVault,
    lookupTableAccount: PublicKey.default
  };
}

export async function findRaydiumPoolId(tokenMint: string) {
  const cached = poolCache.get(tokenMint);
  if (cached) {
    return cached;
  }

  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  const raydium = await Raydium.load({
    owner: wallet,
    connection,
    cluster: "mainnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed"
  });
  const response = await raydium.api.fetchPoolByMints({
    mint1: WSOL_MINT,
    mint2: tokenMint
  }) as RaydiumPoolListResponse;
  const pool = response?.data?.find((item) => item.type === "Standard");

  if (!pool?.id) {
    throw new Error("Raydium Standard AMM pool was not found for this token");
  }

  poolCache.set(tokenMint, pool.id);
  return pool.id as string;
}

function rawReserveToUiAmount(rawReserve: DecimalLike, decimals: number) {
  return Number(new Decimal(rawReserve.toString()).div(10 ** decimals).toString());
}

export async function getRaydiumTokenPriceUsd(tokenMint: string, solPriceUsd: number) {
  const connection = getRaydiumConnection();
  const poolId = await findRaydiumPoolId(tokenMint);
  const poolKeys = await formatAmmKeysById(connection, new PublicKey(poolId));
  const poolInfo = await Liquidity.fetchInfo({
    connection,
    poolKeys
  });
  const baseMint = poolKeys.baseMint.toBase58();
  const quoteMint = poolKeys.quoteMint.toBase58();
  const baseReserve = rawReserveToUiAmount(poolInfo.baseReserve, poolInfo.baseDecimals);
  const quoteReserve = rawReserveToUiAmount(poolInfo.quoteReserve, poolInfo.quoteDecimals);

  if (baseReserve <= 0 || quoteReserve <= 0 || solPriceUsd <= 0) {
    return 0;
  }

  if (baseMint === tokenMint && quoteMint === WSOL_MINT) {
    return (quoteReserve / baseReserve) * solPriceUsd;
  }

  if (baseMint === WSOL_MINT && quoteMint === tokenMint) {
    return (baseReserve / quoteReserve) * solPriceUsd;
  }

  throw new Error("Raydium pool is not paired with WSOL");
}

async function getTokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey) {
  const ata = getAssociatedTokenAddressSync(mint, owner);

  try {
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return balance.value.uiAmount || 0;
  } catch {
    return 0;
  }
}

async function buildRaydiumSwapTransaction(params: {
  side: SwapSide;
  tokenMint: string;
  amount: number;
  wallet: Keypair;
  connection: Connection;
}) {
  const tokenMint = new PublicKey(params.tokenMint);
  const tokenDecimals = await getTokenDecimals(params.connection, tokenMint);
  const poolId = await findRaydiumPoolId(params.tokenMint);
  const poolKeys = await formatAmmKeysById(params.connection, new PublicKey(poolId));
  const tokenAta = await getAssociatedTokenAddress(tokenMint, params.wallet.publicKey);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, params.wallet.publicKey);
  const token = new Token(TOKEN_PROGRAM_ID, tokenMint, tokenDecimals);
  const wsol = Token.WSOL;
  const inputToken = params.side === "buy" ? wsol : token;
  const outputToken = params.side === "buy" ? token : wsol;
  const amountIn = new TokenAmount(
    inputToken,
    new BN(new Decimal(params.amount).mul(10 ** inputToken.decimals).toFixed(0))
  );
  const poolInfo = await Liquidity.fetchInfo({
    connection: params.connection,
    poolKeys
  });
  const { minAmountOut } = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut: outputToken,
    slippage: new Percent(params.side === "buy" ? 3 : 5, 100)
  });
  const { innerTransaction } = await Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys,
      userKeys: {
        tokenAccountIn: params.side === "buy" ? wsolAta : tokenAta,
        tokenAccountOut: params.side === "buy" ? tokenAta : wsolAta,
        owner: params.wallet.publicKey
      },
      amountIn: amountIn.raw,
      minAmountOut: minAmountOut.raw
    },
    poolKeys.version
  );
  const latestBlockhash = await params.connection.getLatestBlockhash("confirmed");
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 140000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      params.wallet.publicKey,
      wsolAta,
      params.wallet.publicKey,
      NATIVE_MINT
    ),
    ...(params.side === "buy"
      ? [
          SystemProgram.transfer({
            fromPubkey: params.wallet.publicKey,
            toPubkey: wsolAta,
            lamports: Math.ceil(params.amount * LAMPORTS_PER_SOL)
          }),
          createSyncNativeInstruction(wsolAta),
          createAssociatedTokenAccountIdempotentInstruction(
            params.wallet.publicKey,
            tokenAta,
            params.wallet.publicKey,
            tokenMint
          )
        ]
      : []),
    ...innerTransaction.instructions,
    createCloseAccountInstruction(wsolAta, params.wallet.publicKey, params.wallet.publicKey)
  ];
  const message = new TransactionMessage({
    payerKey: params.wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([params.wallet, ...innerTransaction.signers]);

  return {
    poolId,
    transaction,
    latestBlockhash
  };
}

export async function executeRaydiumBuy(tokenMint: string, amountSol: number): Promise<RaydiumSwapResult> {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  const mint = new PublicKey(tokenMint);
  const before = await getTokenBalance(connection, wallet.publicKey, mint);
  const { poolId, transaction, latestBlockhash } = await buildRaydiumSwapTransaction({
    side: "buy",
    tokenMint,
    amount: amountSol,
    wallet,
    connection
  });
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  await connection.confirmTransaction({ ...latestBlockhash, signature }, "confirmed");
  const after = await getTokenBalance(connection, wallet.publicKey, mint);

  return {
    tokenMint,
    side: "buy",
    poolId,
    signature,
    tokenAmountDelta: Math.max(0, after - before)
  };
}

export async function executeRaydiumSell(tokenMint: string, tokenAmount: number): Promise<RaydiumSwapResult> {
  const connection = getRaydiumConnection();
  const wallet = getTradingWallet();
  const mint = new PublicKey(tokenMint);
  const before = await getTokenBalance(connection, wallet.publicKey, mint);
  const { poolId, transaction, latestBlockhash } = await buildRaydiumSwapTransaction({
    side: "sell",
    tokenMint,
    amount: tokenAmount,
    wallet,
    connection
  });
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  await connection.confirmTransaction({ ...latestBlockhash, signature }, "confirmed");
  const after = await getTokenBalance(connection, wallet.publicKey, mint);

  return {
    tokenMint,
    side: "sell",
    poolId,
    signature,
    tokenAmountDelta: Math.max(0, before - after)
  };
}
