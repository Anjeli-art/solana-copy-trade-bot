import http from "http";
import { sendError, sendJson, sendNoContent } from "./http/response";
import { handleAnalytics } from "./routes/analytics";
import { handleActivePositions, handleClosedPositions } from "./routes/positions";
import { handleLogs } from "./routes/logs";
import { handleManualTokens } from "./routes/manualTokens";
import { handleRaydium } from "./routes/raydium";
import { handleSwap } from "./routes/swap";
import { handleSettings } from "./routes/settings";
import { handleTokenBlacklist } from "./routes/tokenBlacklist";
import { handleTokens } from "./routes/tokens";
import { handleTraders } from "./routes/traders";
import { handleTrading } from "./routes/trading";
import { handleWallet } from "./routes/wallet";
import { refreshWalletBalance } from "./services/walletBalance";
import { readState } from "./state/store";

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

    if (parts[0] === "api" && parts[1] === "raydium") {
      await handleRaydium(request, response, parts[2]);
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

    sendError(response, 404, "NOT_FOUND", "Endpoint not found");
  } catch (error) {
    console.error(error);
    sendError(response, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`Copy bot API listening at http://${host}:${port}`);
});
