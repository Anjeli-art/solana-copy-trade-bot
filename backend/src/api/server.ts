import http from "http";
import { readJsonBody } from "./http/request";
import { sendError, sendJson, sendNoContent } from "./http/response";
import { handleAnalytics } from "./routes/analytics";
import { handleActivePositions, handleClosedPositions } from "./routes/positions";
import { handleLogs } from "./routes/logs";
import { handleManualTokens } from "./routes/manualTokens";
import { handleSwap } from "./routes/swap";
import { handleSettings } from "./routes/settings";
import { handleTokenBlacklist } from "./routes/tokenBlacklist";
import { handleTokens } from "./routes/tokens";
import { handleTraders } from "./routes/traders";
import { handleMirror } from "./routes/mirror";
import { handleTrading } from "./routes/trading";
import { handleWallet, handleWalletSweepRent } from "./routes/wallet";
import { refreshWalletBalance } from "./services/walletBalance";
import { readState, saveWallet } from "./state/store";
import { attachRealtimeServer } from "./realtime/realtimeServer";
import { broadcaster } from "./realtime/broadcaster";

const host = process.env.API_HOST || "127.0.0.1";
const port = Number(process.env.API_PORT || 3001);

function getPathParts(pathname: string) {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      sendNoContent(response);
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    const parts = getPathParts(url.pathname);

    // Internal IPC endpoint: workers POST realtime events here. Loopback-only
    // since API_HOST defaults to 127.0.0.1. Not exposed publicly.
    if (url.pathname === "/api/internal/realtime" && request.method === "POST") {
      try {
        const body = await readJsonBody(request) as Record<string, unknown> | null;
        if (body && typeof body.type === "string") {
          broadcaster.publish(body as never);
        }
        sendJson(response, 200, { data: { ok: true } });
      } catch {
        sendJson(response, 200, { data: { ok: true } }); // ignore parse errors
      }
      return;
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        data: {
          ok: true,
          service: "copy-bot-api",
          timestamp: new Date().toISOString()
        }
      });
      return;
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      const state = await readState();
      const wallet = await refreshWalletBalance(state.wallet);
      sendJson(response, 200, {
        data: {
          ...state,
          wallet
        }
      });
      return;
    }

    if (url.pathname === "/api/settings") {
      await handleSettings(request, response);
      return;
    }

    if (url.pathname === "/api/wallet") {
      await handleWallet(request, response);
      return;
    }

    if (url.pathname === "/api/wallet/sweep-rent" && request.method === "POST") {
      await handleWalletSweepRent(request, response);
      return;
    }

    if (parts[0] === "api" && parts[1] === "logs") {
      await handleLogs(request, response, parts[2]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "manual-tokens") {
      await handleManualTokens(request, response, parts[2]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "blacklist") {
      await handleTokenBlacklist(request, response, parts[2]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "analytics") {
      await handleAnalytics(request, response, parts[2]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "traders") {
      await handleTraders(request, response, parts[2]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "positions" && parts[2] === "active") {
      await handleActivePositions(request, response, parts[3], parts[4]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "positions" && parts[2] === "closed") {
      await handleClosedPositions(request, response);
      return;
    }

    if (parts[0] === "api" && parts[1] === "swap") {
      await handleSwap(request, response, parts[2]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "tokens") {
      await handleTokens(request, response, parts[2], parts[3]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "trading") {
      await handleTrading(request, response, parts[2]);
      return;
    }

    if (parts[0] === "api" && parts[1] === "mirror") {
      await handleMirror(request, response, parts.slice(2));
      return;
    }

    sendError(response, 404, "NOT_FOUND", "Endpoint not found");
  } catch (error) {
    console.error(error);
    sendError(response, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
});

// Attach WebSocket server for realtime push updates to the UI.
// Frontend connects to ws://host:port/ws and gets a snapshot on connect plus
// every state mutation broadcast through `broadcaster.publish`.
attachRealtimeServer(server);

server.listen(port, host, () => {
  console.log(`Copy bot API listening at http://${host}:${port}`);
  console.log(`Realtime WS endpoint at ws://${host}:${port}/ws`);
});

// Periodically refresh SOL price + wallet balance so workers (and the UI) always have
// a fresh quote when computing USD PnL. Without this, solPriceUsd ages indefinitely
// because workers call refreshWalletBalance() but don't persist back.
// Defaults to every 60s. Override via WALLET_REFRESH_INTERVAL_MS.
const WALLET_REFRESH_INTERVAL_MS = Number(process.env.WALLET_REFRESH_INTERVAL_MS) || 60_000;
setInterval(async () => {
  try {
    const state = await readState();
    const refreshed = await refreshWalletBalance(state.wallet);
    await saveWallet(refreshed);
    // Push wallet update to all connected UI clients via WS — no polling needed.
    broadcaster.publish({ type: "wallet:updated", payload: { wallet: refreshed } });
  } catch (error) {
    console.error(JSON.stringify({
      event: "WALLET_REFRESH_TICK_FAILED",
      message: error instanceof Error ? error.message : "Unknown wallet refresh error"
    }));
  }
}, WALLET_REFRESH_INTERVAL_MS);
