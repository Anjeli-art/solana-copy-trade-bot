/**
 * Realtime WebSocket client for the bot API.
 *
 * Connects to ws://host:3001/ws (or whatever the API base maps to) on import,
 * auto-reconnects with exponential backoff, and exposes a typed event bus that
 * hooks subscribe to.
 *
 * Wire protocol matches the backend `BroadcastEvent` union plus an initial
 * `snapshot` envelope sent immediately on connect so the UI has data without
 * any HTTP round-trips.
 *
 * Polling fallback: each consumer hook subscribes to `connection:status` and
 * can decide to fall back to its own HTTP fetch if the socket has been down
 * for too long.
 */

type ConnectionStatus = "connecting" | "open" | "closed";

export type RealtimeMessage =
  | { type: "snapshot"; payload: SnapshotPayload }
  | { type: "wallet:updated"; payload: { wallet: any } }
  | { type: "mirror_status:updated"; payload: { status: any } }
  | { type: "mirror_position:updated"; payload: { position: any } }
  | { type: "mirror_position:closed"; payload: { position: any } }
  | { type: "mirror_position:opened"; payload: { position: any } }
  | { type: "active_position:updated"; payload: { position: any } }
  | { type: "active_position:closed"; payload: { position: any } }
  | { type: "active_position:opened"; payload: { position: any } }
  | { type: "mirror_traders:updated"; payload: { traders: any[] } }
  | { type: "trackers:updated"; payload: { trackers: any[] } }
  | { type: "settings:updated"; payload: { settings: any } }
  | { type: "bot_log:new"; payload: { log: any } }
  | { type: "pong"; t: number };

export type SnapshotPayload = {
  wallet: any;
  settings: any;
  activePositions: any[];
  mirrorStatus: any;
  mirrorTraders: any[];
  mirrorPositions: any[];
  mirrorClosedPositions: any[];
};

type Listener<E extends RealtimeMessage["type"]> = (
  payload: Extract<RealtimeMessage, { type: E }>
) => void;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

function resolveWsUrl(): string {
  // Use same host as the API base URL with ws:// scheme. Fall back to localhost.
  const apiBase = (import.meta as any).env?.VITE_API_BASE_URL || "http://127.0.0.1:3001";
  try {
    const url = new URL(apiBase);
    const scheme = url.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${url.host}/ws`;
  } catch {
    return "ws://127.0.0.1:3001/ws";
  }
}

class RealtimeClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "closed";
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private eventListeners = new Map<string, Set<(payload: any) => void>>();
  private url = resolveWsUrl();

  constructor() {
    this.connect();
  }

  private setStatus(next: ConnectionStatus) {
    this.status = next;
    for (const l of this.statusListeners) {
      try {
        l(next);
      } catch {
        // listener errors must not break the client loop
      }
    }
  }

  private connect() {
    this.setStatus("connecting");
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
    });

    this.ws.addEventListener("message", (event) => {
      let parsed: RealtimeMessage | null = null;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : "") as RealtimeMessage;
      } catch {
        return;
      }
      if (!parsed || typeof parsed.type !== "string") return;
      const handlers = this.eventListeners.get(parsed.type);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(parsed);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error("ws handler error", e);
          }
        }
      }
    });

    this.ws.addEventListener("error", () => {
      // close handler does the reconnect; no double-schedule here
    });

    this.ws.addEventListener("close", () => {
      this.ws = null;
      this.setStatus("closed");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** this.reconnectAttempt
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Subscribe to a single event type. Returns an unsubscribe function. */
  on<E extends RealtimeMessage["type"]>(type: E, handler: Listener<E>): () => void {
    const handlers = this.eventListeners.get(type) ?? new Set();
    handlers.add(handler as (payload: any) => void);
    this.eventListeners.set(type, handlers);
    return () => {
      handlers.delete(handler as (payload: any) => void);
    };
  }

  /** Subscribe to connection status (open/closed/connecting). */
  onStatus(handler: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(handler);
    handler(this.status);
    return () => {
      this.statusListeners.delete(handler);
    };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }
}

export const realtime = new RealtimeClient();
