/**
 * Helius WebSocket subscription manager.
 *
 * Connects to Helius WebSocket endpoint and manages `logsSubscribe` subscriptions
 * for tracked trader addresses. Pushes new signatures as they appear instead of
 * polling getSignaturesForAddress every few seconds.
 *
 * Features:
 *  - Auto-reconnect with exponential backoff (1s → 30s max)
 *  - Heartbeat ping every 30s to detect silent disconnects
 *  - Dynamic subscription sync: add/remove subscriptions as the tracked list changes
 *  - Listener callback fired for every new signature push
 *
 * Falls back to polling at the worker level — both pipelines feed into the same
 * `handleDetectedBuy` flow and are deduplicated by `processed_signatures`.
 */
import { EventEmitter } from "events";

const RECONNECT_BACKOFF_MIN_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
// Passive liveness check: if no message arrives for this long while we have active
// subscriptions, assume the connection is silently dead and force a reconnect.
// Solana WebSocket only supports pub/sub methods — no getVersion/ping equivalent —
// so we can't actively ping. We rely on subscription notifications and TCP close.
const LIVENESS_CHECK_INTERVAL_MS = 30_000;
const MAX_IDLE_BEFORE_RECONNECT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;

type SubscriptionState = {
  trader: string;
  subscriptionId?: number;
  pendingRequestId?: number;
};

type AccountSubscriptionState = {
  account: string;
  subscriptionId?: number;
  pendingRequestId?: number;
};

export type HeliusLogsNotification = {
  trader: string;
  signature: string;
  slot: number;
  err: unknown;
  logs: string[] | null;
};

export type HeliusAccountNotification = {
  account: string;
  slot: number;
  /** Raw base64-encoded account data. Decode at the call site. */
  dataBase64: string;
  owner: string;
  lamports: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type WebSocketEvents = {
  notification: (event: HeliusLogsNotification) => void;
  accountNotification: (event: HeliusAccountNotification) => void;
  connect: () => void;
  disconnect: (reason: string) => void;
  error: (error: Error) => void;
};

export interface HeliusWebSocketManager extends EventEmitter {
  on<E extends keyof WebSocketEvents>(event: E, listener: WebSocketEvents[E]): this;
  emit<E extends keyof WebSocketEvents>(event: E, ...args: Parameters<WebSocketEvents[E]>): boolean;
}

export class HeliusWebSocketManager extends EventEmitter {
  private endpoint: string;
  private ws: WebSocket | null = null;
  private subscriptionsByTrader = new Map<string, SubscriptionState>();
  private subscriptionIdToTrader = new Map<number, string>();
  private accountSubscriptionsByAccount = new Map<string, AccountSubscriptionState>();
  private subscriptionIdToAccount = new Map<number, string>();
  private pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private reconnectAttempt = 0;
  private livenessTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private connecting = false;
  private connected = false;

  constructor(endpoint: string) {
    super();
    this.endpoint = endpoint;
  }

  start() {
    if (this.closed) {
      this.closed = false;
    }
    this.connect();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopLivenessCheck();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket manager closed"));
    }
    this.pendingRequests.clear();
    this.subscriptionIdToTrader.clear();
    this.subscriptionIdToAccount.clear();
    for (const state of this.subscriptionsByTrader.values()) {
      state.subscriptionId = undefined;
      state.pendingRequestId = undefined;
    }
    for (const state of this.accountSubscriptionsByAccount.values()) {
      state.subscriptionId = undefined;
      state.pendingRequestId = undefined;
    }
  }

  isConnected() {
    return this.connected;
  }

  /**
   * Sync the active subscription set with the provided trader addresses.
   * Adds new subscriptions and removes stale ones. No-op for addresses already subscribed.
   */
  async syncSubscriptions(traders: string[]) {
    const wantedSet = new Set(traders);
    const currentSet = new Set(this.subscriptionsByTrader.keys());

    const toAdd: string[] = [];
    for (const trader of wantedSet) {
      if (!currentSet.has(trader)) {
        toAdd.push(trader);
      }
    }

    const toRemove: string[] = [];
    for (const trader of currentSet) {
      if (!wantedSet.has(trader)) {
        toRemove.push(trader);
      }
    }

    for (const trader of toAdd) {
      this.subscriptionsByTrader.set(trader, { trader });
    }

    if (!this.connected) {
      // Subscriptions will be established when connection comes up.
      // Removed traders just drop from the map; no network action needed.
      for (const trader of toRemove) {
        this.subscriptionsByTrader.delete(trader);
      }
      return;
    }

    for (const trader of toAdd) {
      this.subscribeTrader(trader).catch((error) => {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      });
    }

    for (const trader of toRemove) {
      const state = this.subscriptionsByTrader.get(trader);
      this.subscriptionsByTrader.delete(trader);
      if (state?.subscriptionId !== undefined) {
        this.subscriptionIdToTrader.delete(state.subscriptionId);
        this.unsubscribeTrader(state.subscriptionId).catch(() => {
          // best effort, even if remote unsubscribe fails the local state is already cleared
        });
      }
    }
  }

  private connect() {
    if (this.closed || this.connecting || this.connected) {
      return;
    }
    this.connecting = true;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.endpoint);
    } catch (error) {
      this.connecting = false;
      this.scheduleReconnect(error instanceof Error ? error : new Error("Failed to create WebSocket"));
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.connecting = false;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.emit("connect");
      this.startLivenessCheck();
      // Re-establish trader log subscriptions
      for (const trader of this.subscriptionsByTrader.keys()) {
        this.subscribeTrader(trader).catch((error) => {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        });
      }
      // Re-establish account subscriptions (pool vaults for PumpSwap positions etc.)
      for (const account of this.accountSubscriptionsByAccount.keys()) {
        this.subscribeAccountInternal(account).catch((error) => {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        });
      }
    });

    ws.addEventListener("message", (event) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(typeof event.data === "string" ? event.data : event.data.toString());
    });

    ws.addEventListener("error", (event) => {
      const message = (event as ErrorEvent)?.message || "WebSocket error";
      this.emit("error", new Error(message));
    });

    ws.addEventListener("close", (event) => {
      this.connected = false;
      this.connecting = false;
      this.stopLivenessCheck();
      // Mark every subscription as not yet established remotely
      for (const state of this.subscriptionsByTrader.values()) {
        state.subscriptionId = undefined;
        state.pendingRequestId = undefined;
      }
      for (const state of this.accountSubscriptionsByAccount.values()) {
        state.subscriptionId = undefined;
        state.pendingRequestId = undefined;
      }
      this.subscriptionIdToTrader.clear();
      this.subscriptionIdToAccount.clear();
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WebSocket connection closed"));
      }
      this.pendingRequests.clear();
      this.emit("disconnect", `code=${event.code} reason=${event.reason || ""}`);
      if (!this.closed) {
        this.scheduleReconnect(new Error(`WebSocket closed (code=${event.code})`));
      }
    });
  }

  private scheduleReconnect(_error: Error) {
    if (this.closed) {
      return;
    }
    // Don't emit "error" — disconnect/connect events already convey the lifecycle.
    // Emitting on every reconnect would spam the log feed.
    const delay = Math.min(
      RECONNECT_BACKOFF_MIN_MS * 2 ** this.reconnectAttempt,
      RECONNECT_BACKOFF_MAX_MS
    );
    this.reconnectAttempt += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startLivenessCheck() {
    this.stopLivenessCheck();
    // Solana WebSocket only supports pub/sub methods, no getVersion/ping.
    // We check passively: if no message of any kind arrives for too long,
    // we assume the connection is dead and force a reconnect.
    this.livenessTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const idleMs = Date.now() - this.lastMessageAt;
      if (idleMs > MAX_IDLE_BEFORE_RECONNECT_MS) {
        try {
          this.ws.close();
        } catch {
          // ignore
        }
      }
    }, LIVENESS_CHECK_INTERVAL_MS);
  }

  private stopLivenessCheck() {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /**
   * Subscribe to an arbitrary account's data changes. Useful for pool vault subscriptions
   * — every swap in a pool changes the vault balance, so the notification gives us
   * real-time price updates without polling.
   */
  async subscribeAccount(account: string) {
    if (this.accountSubscriptionsByAccount.has(account)) {
      return;
    }
    this.accountSubscriptionsByAccount.set(account, { account });
    if (this.connected) {
      await this.subscribeAccountInternal(account);
    }
  }

  async unsubscribeAccount(account: string) {
    const state = this.accountSubscriptionsByAccount.get(account);
    this.accountSubscriptionsByAccount.delete(account);
    if (state?.subscriptionId !== undefined) {
      this.subscriptionIdToAccount.delete(state.subscriptionId);
      if (this.connected) {
        await this.unsubscribeAccountInternal(state.subscriptionId).catch(() => undefined);
      }
    }
  }

  private async subscribeAccountInternal(account: string) {
    const state = this.accountSubscriptionsByAccount.get(account);
    if (!state) return;
    if (state.subscriptionId !== undefined) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const id = this.nextRequestId++;
    state.pendingRequestId = id;
    const subscriptionId = await this.sendRequestAndWait<number>({
      jsonrpc: "2.0",
      id,
      method: "accountSubscribe",
      params: [
        account,
        // `processed` cuts ~300-500ms off vs `confirmed`. Account-state push fires
        // as soon as a leader includes the tx in a block, not after vote lockout.
        // Worth the marginal fork-rollback risk because price updates are
        // idempotent — we just recompute on next push.
        { encoding: "base64", commitment: "processed" }
      ]
    }, id);
    state.pendingRequestId = undefined;
    state.subscriptionId = subscriptionId;
    this.subscriptionIdToAccount.set(subscriptionId, account);
  }

  private async unsubscribeAccountInternal(subscriptionId: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.nextRequestId++;
    await this.sendRequestAndWait<boolean>({
      jsonrpc: "2.0",
      id,
      method: "accountUnsubscribe",
      params: [subscriptionId]
    }, id).catch(() => undefined);
  }

  private async subscribeTrader(trader: string) {
    const state = this.subscriptionsByTrader.get(trader);
    if (!state) {
      return;
    }
    if (state.subscriptionId !== undefined) {
      return; // already subscribed
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return; // will retry on next connect
    }

    const id = this.nextRequestId++;
    state.pendingRequestId = id;
    const subscriptionId = await this.sendRequestAndWait<number>({
      jsonrpc: "2.0",
      id,
      method: "logsSubscribe",
      params: [
        { mentions: [trader] },
        // CRITICAL for snipe latency. `processed` fires when leader includes the
        // tx in a block (~400ms after broadcast). `confirmed` waits for vote
        // lockout (~800-1200ms). This is the difference between being the 5th
        // wallet vs the 2nd wallet after the trader.
        // Risk: <0.1% of `processed` txs roll back on fork. We accept that — the
        // alternative cost is missed snipes which is much worse.
        { commitment: "processed" }
      ]
    }, id);
    state.pendingRequestId = undefined;
    state.subscriptionId = subscriptionId;
    this.subscriptionIdToTrader.set(subscriptionId, trader);
  }

  private async unsubscribeTrader(subscriptionId: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const id = this.nextRequestId++;
    await this.sendRequestAndWait<boolean>({
      jsonrpc: "2.0",
      id,
      method: "logsUnsubscribe",
      params: [subscriptionId]
    }, id).catch(() => undefined);
  }

  private sendRequest(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private sendRequestAndWait<T>(payload: { id: number; [key: string]: unknown }, id: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`WebSocket request ${id} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      try {
        this.sendRequest(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error("Failed to send WebSocket request"));
      }
    });
  }

  private handleMessage(raw: string) {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: {
        result?: {
          context?: { slot?: number };
          value?: {
            signature?: string;
            err?: unknown;
            logs?: string[] | null;
          };
        };
        subscription?: number;
      };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || "WebSocket RPC error"));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method === "logsNotification" && message.params) {
      const subscription = message.params.subscription;
      const trader = subscription !== undefined ? this.subscriptionIdToTrader.get(subscription) : undefined;
      const value = message.params.result?.value;
      const signature = value?.signature;
      if (trader && signature) {
        this.emit("notification", {
          trader,
          signature,
          slot: message.params.result?.context?.slot || 0,
          err: value?.err,
          logs: value?.logs || null
        });
      }
      return;
    }

    if (message.method === "accountNotification") {
      const accountMessage = message as unknown as {
        params?: {
          result?: {
            context?: { slot?: number };
            value?: {
              data?: [string, string] | string;
              owner?: string;
              lamports?: number;
            };
          };
          subscription?: number;
        };
      };
      const subscription = accountMessage.params?.subscription;
      const account = subscription !== undefined ? this.subscriptionIdToAccount.get(subscription) : undefined;
      const value = accountMessage.params?.result?.value;
      if (account && value) {
        const dataField = value.data;
        const dataBase64 = Array.isArray(dataField) ? dataField[0] : (dataField || "");
        this.emit("accountNotification", {
          account,
          slot: accountMessage.params?.result?.context?.slot || 0,
          dataBase64,
          owner: value.owner || "",
          lamports: value.lamports || 0
        });
      }
    }
  }
}

export function getWebSocketEndpoint(): string {
  return process.env.WEBSOCKET_ENDPOINT || process.env.MAINNET_WS_ENDPOINT || "";
}

export function createHeliusWebSocketManager(): HeliusWebSocketManager | null {
  const endpoint = getWebSocketEndpoint();
  if (!endpoint) {
    return null;
  }
  return new HeliusWebSocketManager(endpoint);
}
