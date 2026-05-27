/**
 * Worker-side helper for publishing realtime events to the main server.
 *
 * Workers (mirror, profit, copy) run as separate Node processes spawned via npm.
 * They cannot access the in-process `broadcaster` singleton because it lives in
 * the main API server's process. Instead, they POST events to the localhost
 * HTTP endpoint, which then publishes to the broadcaster.
 *
 * Fire-and-forget: never blocks the caller, never throws — failure to publish a
 * realtime event must not break trading logic. Worst case: the UI misses one
 * push and catches up on the next event or snapshot.
 */
import type { BroadcastEvent } from "./broadcaster";

const REALTIME_INTERNAL_URL =
  process.env.REALTIME_INTERNAL_URL ||
  `http://${process.env.API_HOST || "127.0.0.1"}:${process.env.API_PORT || 3001}/api/internal/realtime`;

export function publishRealtimeFromWorker(event: BroadcastEvent): void {
  // Detached fetch — let it run in background, swallow all errors.
  fetch(REALTIME_INTERNAL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  }).catch(() => {
    // Server might be down; ignore. The next snapshot will reconcile state.
  });
}
