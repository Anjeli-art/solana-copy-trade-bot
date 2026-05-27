/**
 * Realtime WebSocket server attached to the main HTTP server.
 *
 * Path: ws://host:port/ws
 *
 * Protocol:
 *   - Server → Client: JSON-stringified BroadcastEvent on every state change
 *   - Server → Client on connect: a single `welcome` envelope with the current
 *     snapshot of wallet/status/positions/etc so the client doesn't need to fetch
 *   - Client → Server: optional `ping` messages (kept-alive). Ignored otherwise.
 *
 * Reliability:
 *   - On every client open, we send a snapshot
 *   - Push events are best-effort: if the socket is buffering or dead we just skip
 *   - 30s server-initiated ping to detect zombie sockets
 */
import { Server as HttpServer } from "http";
import { Socket as NetSocket } from "net";
import WebSocket = require("ws");
import { broadcaster, type BroadcastEvent } from "./broadcaster";
import { readState } from "../state/store";
import { refreshWalletBalance } from "../services/walletBalance";
import { db } from "../db/sqlite";
import { getMirrorStatus } from "../services/tradingEngine";

const HEARTBEAT_INTERVAL_MS = 30_000;

type Snapshot = {
  type: "snapshot";
  payload: {
    wallet: unknown;
    settings: unknown;
    activePositions: unknown;
    mirrorStatus: unknown;
    mirrorTraders: unknown;
    mirrorPositions: unknown;
    mirrorClosedPositions: unknown;
  };
};

async function buildSnapshot(): Promise<Snapshot> {
  const state = await readState();
  const wallet = await refreshWalletBalance(state.wallet);
  const mirrorTraders = db
    .prepare("SELECT * FROM mirror_traders ORDER BY created_at DESC")
    .all();
  const mirrorPositions = db
    .prepare("SELECT * FROM mirror_positions WHERE status = 'open' ORDER BY opened_at DESC")
    .all();
  const mirrorClosedPositions = db
    .prepare("SELECT * FROM mirror_closed_positions ORDER BY closed_at DESC LIMIT 200")
    .all();
  return {
    type: "snapshot",
    payload: {
      wallet,
      settings: state.settings,
      activePositions: state.activePositions,
      mirrorStatus: getMirrorStatus(),
      mirrorTraders,
      mirrorPositions,
      mirrorClosedPositions
    }
  };
}

export function attachRealtimeServer(httpServer: HttpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket as NetSocket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, request);
    });
  });

  const aliveSockets = new WeakSet<WebSocket>();

  wss.on("connection", async (ws: WebSocket) => {
    aliveSockets.add(ws);

    // Send the initial snapshot immediately so the client doesn't need to fetch.
    try {
      const snapshot = await buildSnapshot();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(snapshot));
      }
    } catch (error) {
      console.error("realtime: snapshot failed", error);
    }

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      // Client→server messages are currently advisory only. Accept ping/keepalive,
      // ignore everything else. Reserved for future channel-subscribe commands.
      try {
        const data = JSON.parse(raw.toString());
        if (data?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("pong", () => {
      aliveSockets.add(ws);
    });

    ws.on("close", () => {
      aliveSockets.delete(ws);
    });
  });

  // Forward every broadcaster event to every connected client.
  broadcaster.subscribe((event: BroadcastEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        // bufferedAmount > 1MB → client is slow / dead, skip this push to avoid
        // memory pile-up. They'll get caught up on next snapshot or the next
        // event after they drain.
        if (client.bufferedAmount > 1_000_000) continue;
        try {
          client.send(payload);
        } catch {
          // ignore individual client errors — keep iterating
        }
      }
    }
  });

  // Heartbeat: ping every 30s. If a client doesn't pong before next interval,
  // terminate the socket so we don't leak handles on phantom clients.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!aliveSockets.has(client)) {
        client.terminate();
        continue;
      }
      aliveSockets.delete(client);
      try {
        client.ping();
      } catch {
        // socket already dead; next tick removes it
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  return wss;
}
