/**
 * Real-time event broadcaster.
 *
 * Singleton that other backend modules call to publish state changes. A websocket
 * server attached to the HTTP server (see realtimeServer.ts) listens for events
 * from this hub and broadcasts them to every connected client.
 *
 * Design notes:
 *   - Push-only. We don't track per-client subscriptions — clients subscribe to
 *     "everything" and filter on their side. This keeps the wire simple and the
 *     payload volume is small enough (one user, a few open positions).
 *   - Synchronous emit. Subscribers handle events without awaits to keep the call
 *     site cheap.
 *   - Type-safe events: each event has a typed payload. Adding a new event means
 *     extending the discriminated union.
 */
import { EventEmitter } from "events";

export type BroadcastEvent =
  | { type: "wallet:updated"; payload: { wallet: unknown } }
  | { type: "mirror_status:updated"; payload: { status: unknown } }
  | { type: "mirror_position:updated"; payload: { position: unknown } }
  | { type: "mirror_position:closed"; payload: { position: unknown } }
  | { type: "mirror_position:opened"; payload: { position: unknown } }
  | { type: "active_position:updated"; payload: { position: unknown } }
  | { type: "active_position:closed"; payload: { position: unknown } }
  | { type: "active_position:opened"; payload: { position: unknown } }
  | { type: "mirror_traders:updated"; payload: { traders: unknown } }
  | { type: "trackers:updated"; payload: { trackers: unknown } }
  | { type: "settings:updated"; payload: { settings: unknown } }
  | { type: "bot_log:new"; payload: { log: unknown } };

class Broadcaster {
  private emitter = new EventEmitter();

  constructor() {
    // Default cap is 10 — we attach multiple listeners (one per ws client).
    this.emitter.setMaxListeners(1000);
  }

  publish(event: BroadcastEvent) {
    this.emitter.emit("event", event);
  }

  subscribe(handler: (event: BroadcastEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}

export const broadcaster = new Broadcaster();
