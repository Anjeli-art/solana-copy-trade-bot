import type { IncomingMessage, ServerResponse } from "http";
import { db } from "../db/sqlite";
import { sendError, sendJson } from "../http/response";
import { readJsonBody } from "../http/request";
import { executeJupiterSell } from "../services/jupiterSwap";
import { executePumpSwapSell } from "../services/pumpswapSwap";
import { executePumpFunSell } from "../services/pumpfunSwap";
import { executeRaydiumAmmV4Sell } from "../services/raydiumAmmV4Swap";
import { executeRaydiumCpmmSell, executeRaydiumClmmSell } from "../services/raydiumCpmmClmmSwap";
import { executeOrcaWhirlpoolSell } from "../services/orcaWhirlpoolSwap";
import { createBotLog } from "../services/logs";
import { getTokenMetadata } from "../services/tokenMetadata";
import { refreshWalletBalance } from "../services/walletBalance";
import { readState } from "../state/store";
import { startMirrorTrading, stopMirrorTrading, getMirrorStatus } from "../services/tradingEngine";

function now() {
  return new Date().toISOString();
}

type DbMirrorPosition = {
  id: string;
  token_mint: string;
  token_symbol: string | null;
  mirror_trader: string;
  source_buy_signature: string | null;
  buy_tx: string | null;
  entry_price_usd: number;
  current_price_usd: number;
  token_amount: number;
  sol_spent: number;
  opened_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  buy_platform: string | null;
  pool_address: string | null;
  pool_base_vault: string | null;
  pool_quote_vault: string | null;
  pool_base_decimals: number | null;
  monitor_type: string | null;
};

function getMirrorTraders() {
  return db
    .prepare("SELECT address, label, enabled, buy_amount_sol, created_at, updated_at FROM mirror_traders ORDER BY created_at DESC")
    .all() as Array<{
      address: string;
      label: string | null;
      enabled: number;
      buy_amount_sol: number;
      created_at: string;
      updated_at: string;
    }>;
}

function getMirrorPositions() {
  return db
    .prepare(
      "SELECT * FROM mirror_positions WHERE status = 'open' ORDER BY opened_at DESC"
    )
    .all() as DbMirrorPosition[];
}

function getMirrorClosedPositions() {
  return db
    .prepare(
      "SELECT * FROM mirror_closed_positions ORDER BY closed_at DESC LIMIT 200"
    )
    .all() as Array<{
      id: string;
      token_mint: string;
      token_symbol: string | null;
      mirror_trader: string;
      source_buy_signature: string | null;
      source_sell_signature: string | null;
      buy_tx: string | null;
      sell_tx: string | null;
      entry_price_usd: number;
      exit_price_usd: number;
      token_amount: number;
      sol_spent: number;
      sol_received: number | null;
      close_reason: string;
      buy_platform: string | null;
      exit_platform: string | null;
      ata_rent_recovered: number | null;
      opened_at: string;
      closed_at: string;
      created_at: string;
    }>;
}

export async function handleMirror(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[]
) {
  const method = request.method || "GET";

  // GET /api/mirror/status
  if (parts[0] === "status" && method === "GET") {
    sendJson(response, 200, { data: getMirrorStatus() });
    return;
  }

  // POST /api/mirror/start
  if (parts[0] === "start" && method === "POST") {
    const status = startMirrorTrading();
    sendJson(response, 200, { data: status });
    return;
  }

  // POST /api/mirror/stop
  if (parts[0] === "stop" && method === "POST") {
    const status = stopMirrorTrading();
    sendJson(response, 200, { data: status });
    return;
  }

  // GET /api/mirror/traders
  if (parts[0] === "traders" && !parts[1] && method === "GET") {
    const traders = getMirrorTraders().map((t) => ({
      address: t.address,
      label: t.label,
      enabled: Boolean(t.enabled),
      buyAmountSol: t.buy_amount_sol,
      createdAt: t.created_at,
      updatedAt: t.updated_at
    }));
    sendJson(response, 200, { data: traders });
    return;
  }

  // POST /api/mirror/traders
  if (parts[0] === "traders" && !parts[1] && method === "POST") {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const { address, label, buyAmountSol } = body as {
      address?: string;
      label?: string;
      buyAmountSol?: number;
    };

    if (!address || typeof address !== "string" || address.length < 32) {
      sendError(response, 400, "INVALID_ADDRESS", "Valid Solana address is required");
      return;
    }

    const amount = typeof buyAmountSol === "number" && buyAmountSol > 0 ? buyAmountSol : 0.1;
    const existingMirrorWallet = getMirrorTraders().find((trader) => trader.address !== address);

    if (existingMirrorWallet) {
      sendError(response, 409, "MIRROR_WALLET_EXISTS", "Only one mirror wallet can be connected");
      return;
    }

    db.prepare(`
      INSERT OR REPLACE INTO mirror_traders (address, label, enabled, buy_amount_sol, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(address, label || null, amount, now(), now());

    createBotLog({
      event: "MIRROR_TRADER_ADDED",
      message: `Mirror trader added: ${address}`,
      trader: address,
      metadata: { label, buyAmountSol: amount }
    });

    sendJson(response, 200, {
      data: getMirrorTraders().map((t) => ({
        address: t.address,
        label: t.label,
        enabled: Boolean(t.enabled),
        buyAmountSol: t.buy_amount_sol,
        createdAt: t.created_at,
        updatedAt: t.updated_at
      }))
    });
    return;
  }

  // PATCH /api/mirror/traders/:address
  if (parts[0] === "traders" && parts[1] && method === "PATCH") {
    const address = parts[1];
    const body = await readJsonBody<Record<string, unknown>>(request);
    const { label, enabled, buyAmountSol } = body as {
      label?: string;
      enabled?: boolean;
      buyAmountSol?: number;
    };

    const existing = db.prepare("SELECT address FROM mirror_traders WHERE address = ?").get(address);
    if (!existing) {
      sendError(response, 404, "NOT_FOUND", "Mirror trader not found");
      return;
    }

    if (typeof enabled === "boolean") {
      db.prepare("UPDATE mirror_traders SET enabled = ?, updated_at = ? WHERE address = ?")
        .run(enabled ? 1 : 0, now(), address);
    }
    if (typeof label === "string") {
      db.prepare("UPDATE mirror_traders SET label = ?, updated_at = ? WHERE address = ?")
        .run(label || null, now(), address);
    }
    if (typeof buyAmountSol === "number" && buyAmountSol > 0) {
      db.prepare("UPDATE mirror_traders SET buy_amount_sol = ?, updated_at = ? WHERE address = ?")
        .run(buyAmountSol, now(), address);
    }

    sendJson(response, 200, {
      data: getMirrorTraders().map((t) => ({
        address: t.address,
        label: t.label,
        enabled: Boolean(t.enabled),
        buyAmountSol: t.buy_amount_sol,
        createdAt: t.created_at,
        updatedAt: t.updated_at
      }))
    });
    return;
  }

  // DELETE /api/mirror/traders/:address
  if (parts[0] === "traders" && parts[1] && method === "DELETE") {
    const address = parts[1];
    const existing = db.prepare("SELECT address FROM mirror_traders WHERE address = ?").get(address);
    if (!existing) {
      sendError(response, 404, "NOT_FOUND", "Mirror trader not found");
      return;
    }

    db.prepare("DELETE FROM mirror_traders WHERE address = ?").run(address);
    createBotLog({
      event: "MIRROR_TRADER_REMOVED",
      message: `Mirror trader removed: ${address}`,
      trader: address
    });

    sendJson(response, 200, {
      data: getMirrorTraders().map((t) => ({
        address: t.address,
        label: t.label,
        enabled: Boolean(t.enabled),
        buyAmountSol: t.buy_amount_sol,
        createdAt: t.created_at,
        updatedAt: t.updated_at
      }))
    });
    return;
  }

  // GET /api/mirror/positions
  if (parts[0] === "positions" && !parts[1] && method === "GET") {
    const positions = getMirrorPositions();
    // Fetch token metadata for display
    const enriched = await Promise.all(
      positions.map(async (pos) => {
        const meta = await getTokenMetadata(pos.token_mint).catch(() => undefined);
        return {
          id: pos.id,
          tokenMint: pos.token_mint,
          tokenSymbol: meta?.symbol || pos.token_symbol || pos.token_mint.slice(0, 6),
          tokenName: meta?.name,
          tokenImage: meta?.image,
          mirrorTrader: pos.mirror_trader,
          sourceBuySignature: pos.source_buy_signature,
          buyTx: pos.buy_tx,
          buyPlatform: pos.buy_platform || null,
          monitorType: pos.monitor_type || null,
          entryPriceUsd: pos.entry_price_usd,
          currentPriceUsd: pos.current_price_usd,
          tokenAmount: pos.token_amount,
          solSpent: pos.sol_spent,
          openedAt: pos.opened_at,
          status: pos.status
        };
      })
    );
    sendJson(response, 200, { data: enriched });
    return;
  }

  // GET /api/mirror/positions/closed
  if (parts[0] === "positions" && parts[1] === "closed" && method === "GET") {
    const positions = getMirrorClosedPositions();
    const enriched = await Promise.all(
      positions.map(async (pos) => {
        const meta = await getTokenMetadata(pos.token_mint).catch(() => undefined);
        return {
          id: pos.id,
          tokenMint: pos.token_mint,
          tokenSymbol: meta?.symbol || pos.token_symbol || pos.token_mint.slice(0, 6),
          tokenName: meta?.name,
          tokenImage: meta?.image,
          mirrorTrader: pos.mirror_trader,
          sourceBuySignature: pos.source_buy_signature,
          sourceSellSignature: pos.source_sell_signature,
          buyTx: pos.buy_tx,
          sellTx: pos.sell_tx,
          buyPlatform: pos.buy_platform || null,
          exitPlatform: pos.exit_platform || null,
          entryPriceUsd: pos.entry_price_usd,
          exitPriceUsd: pos.exit_price_usd,
          tokenAmount: pos.token_amount,
          solSpent: pos.sol_spent,
          solReceived: pos.sol_received,
          ataRentRecovered: pos.ata_rent_recovered ?? 0,
          closeReason: pos.close_reason,
          openedAt: pos.opened_at,
          closedAt: pos.closed_at
        };
      })
    );
    sendJson(response, 200, { data: enriched });
    return;
  }

  // POST /api/mirror/positions/:id/sell (manual sell)
  if (parts[0] === "positions" && parts[1] && parts[2] === "sell" && method === "POST") {
    const positionId = parts[1];
    const pos = db.prepare("SELECT * FROM mirror_positions WHERE id = ? AND status = 'open'").get(
      positionId
    ) as DbMirrorPosition | undefined;

    if (!pos) {
      sendError(response, 404, "NOT_FOUND", "Mirror position not found or already closed");
      return;
    }

    if (pos.token_amount <= 0) {
      sendError(response, 400, "ZERO_AMOUNT", "Position has zero token amount");
      return;
    }

    try {
      // Route through native connector when monitor_type was recorded at buy time.
      // Falls back to Jupiter for non-native platforms.
      const tokenDecimals = pos.pool_base_decimals ?? 0;
      const useNativePumpSwap =
        pos.monitor_type === "pumpswap" && Boolean(pos.pool_address);
      const useNativePumpFun = pos.monitor_type === "pumpfun";
      const useNativeRaydium =
        pos.monitor_type === "raydium_amm_v4" && Boolean(pos.pool_address);
      const useNativeRaydiumCpmm =
        pos.monitor_type === "raydium_cpmm" && Boolean(pos.pool_address);
      const useNativeRaydiumClmm =
        pos.monitor_type === "raydium_clmm" && Boolean(pos.pool_address);
      const useNativeOrca =
        pos.monitor_type === "orca_whirlpool" && Boolean(pos.pool_address);
      const result = useNativePumpSwap
        ? await executePumpSwapSell(pos.token_mint, pos.token_amount, pos.pool_address as string)
        : useNativePumpFun
          ? await executePumpFunSell(pos.token_mint, pos.token_amount)
          : useNativeRaydium
            ? await executeRaydiumAmmV4Sell(pos.token_mint, pos.token_amount, pos.pool_address as string)
            : useNativeRaydiumCpmm
              ? await executeRaydiumCpmmSell(
                  pos.token_mint,
                  pos.token_amount,
                  tokenDecimals,
                  pos.pool_address as string
                )
              : useNativeRaydiumClmm
                ? await executeRaydiumClmmSell(
                    pos.token_mint,
                    pos.token_amount,
                    tokenDecimals,
                    pos.pool_address as string
                  )
                : useNativeOrca
                  ? await executeOrcaWhirlpoolSell(
                      pos.token_mint,
                      pos.token_amount,
                      tokenDecimals,
                      pos.pool_address as string
                    )
                  : await executeJupiterSell(pos.token_mint, pos.token_amount);
      const executionRoute = useNativePumpSwap
        ? "PumpSwap"
        : useNativePumpFun
          ? "Pump.fun"
          : useNativeRaydium
            ? "Raydium"
            : useNativeRaydiumCpmm
              ? "Raydium-CPMM"
              : useNativeRaydiumClmm
                ? "Raydium-CLMM"
                : useNativeOrca
                  ? "Orca"
                  : "Jupiter";
      const state = await readState();
      const wallet = await refreshWalletBalance(state.wallet);
      const solReceived = result.actualSolChange !== undefined
        ? Math.abs(result.actualSolChange)
        : result.outputSol || 0;
      const exitPriceUsd =
        pos.token_amount > 0 ? (solReceived * wallet.solPriceUsd) / pos.token_amount : 0;

      db.prepare(`
        INSERT INTO mirror_closed_positions (
          id, token_mint, token_symbol, mirror_trader,
          source_buy_signature, source_sell_signature,
          buy_tx, sell_tx,
          entry_price_usd, exit_price_usd,
          token_amount, sol_spent, sol_received,
          close_reason, buy_platform, exit_platform,
          opened_at, closed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)
      `).run(
        pos.id,
        pos.token_mint,
        pos.token_symbol,
        pos.mirror_trader,
        pos.source_buy_signature,
        null,
        pos.buy_tx,
        result.signature || null,
        pos.entry_price_usd,
        exitPriceUsd,
        pos.token_amount,
        pos.sol_spent,
        solReceived,
        pos.buy_platform || null,
        executionRoute,
        pos.opened_at,
        now(),
        now()
      );
      db.prepare("DELETE FROM mirror_positions WHERE id = ?").run(pos.id);

      createBotLog({
        event: "MIRROR_SELL_MANUAL",
        message: `Manual mirror sell executed for ${pos.token_mint} through ${executionRoute}`,
        tokenMint: pos.token_mint,
        trader: pos.mirror_trader,
        signature: result.signature,
        metadata: {
          positionId,
          solReceived,
          exitPriceUsd,
          tokenAmount: pos.token_amount,
          executionRoute,
          buyPlatform: pos.buy_platform
        }
      });

      sendJson(response, 200, {
        data: {
          positions: getMirrorPositions(),
          sold: true,
          signature: result.signature
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sell failed";
      createBotLog({
        level: "error",
        event: "MIRROR_SELL_MANUAL_FAILED",
        message,
        tokenMint: pos.token_mint,
        trader: pos.mirror_trader
      });
      sendError(response, 500, "SELL_FAILED", message);
    }
    return;
  }

  sendError(response, 404, "NOT_FOUND", "Endpoint not found");
}
