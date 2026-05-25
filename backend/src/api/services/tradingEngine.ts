import path from "path";
import { randomUUID } from "crypto";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { db } from "../db/sqlite";
import { getJupiterSwapExecutionDetails } from "./jupiterSwap";
import { createBotLog } from "./logs";
import { getTokenMetadata } from "./tokenMetadata";
import { refreshWalletBalance } from "./walletBalance";
import { addActivePosition, readState } from "../state/store";

type ManagedProcess = {
  name: "copy" | "profit-low" | "profit-high" | "mirror";
  process: ChildProcessWithoutNullStreams;
};

type TradingEngineState = {
  copyEnabled: boolean;
  profitEnabled: boolean;
  mirrorEnabled: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
};

const backendRoot = path.resolve(__dirname, "../../..");
const state: TradingEngineState = {
  copyEnabled: false,
  profitEnabled: false,
  mirrorEnabled: false
};
const processes: ManagedProcess[] = [];

// Kill any workers left from a previous server session
function cleanupStaleWorkers() {
  const rows = db.prepare("SELECT name, pid FROM running_workers").all() as Array<{ name: string; pid: number }>;
  for (const row of rows) {
    try {
      process.kill(row.pid, "SIGTERM");
      console.log(`[trading] Killed stale worker '${row.name}' (pid ${row.pid}) from previous session`);
    } catch {
      // Process already dead — ignore ESRCH
    }
  }
  if (rows.length > 0) {
    db.prepare("DELETE FROM running_workers").run();
  }
}

cleanupStaleWorkers();

async function recoverTxSentCopyBuys() {
  const rows = db
    .prepare(
      `
        SELECT token_mint, source_signature, trader, message
        FROM copy_buy_token_locks
        WHERE status = 'tx_sent' AND message IS NOT NULL AND message != ''
      `
    )
    .all() as Array<{ token_mint: string; source_signature: string; trader: string; message: string }>;

  for (const row of rows) {
    const tokenMint = row.token_mint;
    const buySignature = row.message;
    try {
      const state = await readState();
      const alreadyTracked = [...state.activePositions, ...state.closedPositions].some(
        (position) => position.tokenMint === tokenMint && position.buyTx === buySignature
      );
      if (alreadyTracked) {
        db.prepare(
          "UPDATE copy_buy_token_locks SET status = 'success', updated_at = ? WHERE token_mint = ?"
        ).run(new Date().toISOString(), tokenMint);
        db.prepare(
          "UPDATE processed_signatures SET status = 'success', message = ? WHERE signature = ?"
        ).run(buySignature, row.source_signature);
        continue;
      }

      const details = await getJupiterSwapExecutionDetails({
        signature: buySignature,
        tokenMint
      });
      const tokenAmount = Math.abs(details.tokenDelta || 0);
      const actualSolSpent = details.actualSolChange !== undefined ? Math.abs(details.actualSolChange) : 0;
      if (tokenAmount <= 0 || actualSolSpent <= 0) {
        throw new Error(`Recovered buy tx has invalid deltas: token=${tokenAmount}, sol=${actualSolSpent}`);
      }

      const wallet = await refreshWalletBalance(state.wallet);
      const tokenMetadata = await getTokenMetadata(tokenMint).catch(() => undefined);
      const amountUsd = actualSolSpent * wallet.solPriceUsd;
      const entryPriceUsd = tokenAmount > 0 && amountUsd > 0 ? amountUsd / tokenAmount : 0;
      const openedAt = details.blockTime
        ? new Date(details.blockTime * 1000).toISOString()
        : new Date().toISOString();

      await addActivePosition(
        {
          id: randomUUID(),
          tokenSymbol: tokenMetadata?.symbol || tokenMint.slice(0, 6),
          tokenName: tokenMetadata?.name,
          tokenMint,
          tokenImage: tokenMetadata?.image,
          sourceTrader: row.trader,
          sourceSignature: row.source_signature,
          buyPlatform: "Jupiter",
          buyTx: buySignature,
          entryPriceUsd,
          currentPriceUsd: entryPriceUsd,
          amountUsd,
          solSpent: actualSolSpent,
          buyNetworkFeeSol: details.networkFeeSol,
          buyPriorityFeeSol: details.priorityFeeSol,
          buyQuotedOutAmount: tokenAmount,
          buyActualSolChange: details.actualSolChange,
          tokenAmount,
          openedAt,
          status: "open",
          profitTier: "high"
        },
        wallet
      );

      db.prepare(
        "UPDATE copy_buy_token_locks SET status = 'success', updated_at = ? WHERE token_mint = ?"
      ).run(new Date().toISOString(), tokenMint);
      db.prepare(
        "UPDATE processed_signatures SET status = 'success', message = ? WHERE signature = ?"
      ).run(buySignature, row.source_signature);
      createBotLog({
        event: "COPY_BUY_RECOVERED_FROM_TX",
        message: `Recovered active position for ${tokenMint} from sent buy tx`,
        trader: row.trader,
        tokenMint,
        signature: buySignature,
        metadata: {
          sourceSignature: row.source_signature,
          tokenAmount,
          actualSolChange: details.actualSolChange,
          networkFeeSol: details.networkFeeSol,
          priorityFeeSol: details.priorityFeeSol
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown copy-buy recovery error";
      createBotLog({
        level: "error",
        event: "COPY_BUY_RECOVERY_FAILED",
        message,
        trader: row.trader,
        tokenMint,
        signature: buySignature,
        metadata: {
          sourceSignature: row.source_signature
        }
      });
    }
  }
}

async function recoverStaleCopyBuyAttempts() {
  const recoveredAt = new Date().toISOString();
  db.prepare(
    `
      UPDATE copy_buy_token_locks
      SET status = 'failed',
          message = 'Recovered stale pending copy buy after backend restart',
          updated_at = ?
      WHERE status = 'pending'
    `
  ).run(recoveredAt);
  db.prepare(
    `
      UPDATE processed_signatures
      SET status = 'failed',
          message = 'Recovered stale pending copy buy after backend restart'
      WHERE action = 'copy-buy' AND status = 'pending'
    `
  ).run();
  await recoverTxSentCopyBuys();
}

void recoverStaleCopyBuyAttempts();

function saveWorkerPid(name: string, pid: number) {
  db.prepare(
    "INSERT OR REPLACE INTO running_workers (name, pid, started_at) VALUES (?, ?, ?)"
  ).run(name, pid, new Date().toISOString());
}

function removeWorkerPid(name: string) {
  db.prepare("DELETE FROM running_workers WHERE name = ?").run(name);
}

function setRuntimeFlag(key: string, enabled: boolean) {
  db.prepare(
    `
      INSERT INTO trading_runtime (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `
  ).run(key, enabled ? "true" : "false", new Date().toISOString());
}

// Kill a worker by name — first by PID stored in DB (covers cross-session orphans),
// then by in-memory reference.
function killWorker(name: string) {
  const row = db.prepare("SELECT pid FROM running_workers WHERE name = ?").get(name) as { pid: number } | undefined;
  if (row) {
    try {
      process.kill(row.pid, "SIGTERM");
    } catch {
      // ESRCH — already dead
    }
    removeWorkerPid(name);
  }
  for (const item of processes.filter((p) => p.name === name)) {
    try {
      item.process.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

// Max bytes to keep from stderr per process for crash reporting
const STDERR_BUFFER_MAX = 4000;
const stderrBuffers = new Map<number, string>();

function appendLog(name: string, chunk: Buffer) {
  const text = chunk.toString("utf8").trim();
  if (!text) {
    return;
  }

  for (const line of text.split("\n")) {
    console.log(`[trading:${name}] ${line}`);
  }
}

function bufferStderr(pid: number, chunk: Buffer) {
  const existing = stderrBuffers.get(pid) || "";
  const appended = existing + chunk.toString("utf8");
  stderrBuffers.set(pid, appended.slice(-STDERR_BUFFER_MAX));
}

function isProfitProcess(name: ManagedProcess["name"]) {
  return name === "profit-low" || name === "profit-high";
}

function isMirrorProcess(name: ManagedProcess["name"]) {
  return name === "mirror";
}

function spawnManagedProcess(name: ManagedProcess["name"], script: string, extraEnv: NodeJS.ProcessEnv = {}) {
  if (processes.some((item) => item.name === name)) {
    return;
  }

  const child = spawn("npm", ["run", script], {
    cwd: backendRoot,
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  if (child.pid !== undefined) {
    saveWorkerPid(name, child.pid);
    console.log(`[trading] Spawned worker '${name}' (pid ${child.pid})`);
  }

  child.stdout.on("data", (chunk) => appendLog(name, chunk));
  child.stderr.on("data", (chunk) => {
    if (child.pid !== undefined) bufferStderr(child.pid, chunk);
    appendLog(name, chunk);
  });
  child.on("exit", (code, signal) => {
    const pid = child.pid;
    const stderrSnippet = pid ? stderrBuffers.get(pid) || "" : "";
    if (pid) stderrBuffers.delete(pid);

    removeWorkerPid(name);
    const index = processes.findIndex((item) => item.process.pid === pid);
    if (index >= 0) {
      processes.splice(index, 1);
    }

    const wasEnabled = name === "copy"
      ? state.copyEnabled
      : isMirrorProcess(name)
        ? state.mirrorEnabled
        : state.profitEnabled;

    if (name === "copy") {
      state.copyEnabled = false;
    } else if (isMirrorProcess(name)) {
      state.mirrorEnabled = false;
    } else if (!processes.some((item) => isProfitProcess(item.name))) {
      state.profitEnabled = false;
    }

    if (wasEnabled) {
      // Recover any stale pending copy-buy locks left by the crashed worker
      void recoverStaleCopyBuyAttempts();

      state.stoppedAt = new Date().toISOString();
      state.lastError = `${name} trading process stopped unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}`;
      createBotLog({
        level: "error",
        event: "TRADING_PROCESS_STOPPED",
        message: state.lastError,
        metadata: {
          process: name,
          code,
          signal,
          stderr: stderrSnippet.slice(-2000) || undefined
        }
      });
      console.error(`[trading:${name}] ${state.lastError}`);
    }
  });

  processes.push({ name, process: child });
}

export function getTradingStatus() {
  return {
    enabled: state.copyEnabled || state.profitEnabled,
    ...state,
    processes: processes.map((item) => ({
      name: item.name,
      pid: item.process.pid
    }))
  };
}

export function getMirrorStatus() {
  return {
    enabled: state.mirrorEnabled,
    mirrorEnabled: state.mirrorEnabled,
    processes: processes
      .filter((item) => isMirrorProcess(item.name))
      .map((item) => ({ name: item.name, pid: item.process.pid }))
  };
}

export function startCopyTrading() {
  state.copyEnabled = true;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = undefined;
  state.lastError = undefined;
  setRuntimeFlag("copy_enabled", true);

  spawnManagedProcess("copy", "worker:copy");
  createBotLog({
    event: "COPY_TRADING_STARTED",
    message: "Auto buy was started from UI"
  });

  return getTradingStatus();
}

export function stopCopyTrading() {
  state.copyEnabled = false;
  state.stoppedAt = new Date().toISOString();
  setRuntimeFlag("copy_enabled", false);

  createBotLog({
    event: "COPY_TRADING_STOPPED",
    message: "Auto buy stop was requested from UI"
  });

  return getTradingStatus();
}

export function startProfitWatcher() {
  state.profitEnabled = true;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = undefined;
  state.lastError = undefined;
  setRuntimeFlag("profit_enabled", true);

  spawnManagedProcess("profit-low", "worker:profit", { PROFIT_WATCHER_TIER: "low" });
  spawnManagedProcess("profit-high", "worker:profit", { PROFIT_WATCHER_TIER: "high" });
  createBotLog({
    event: "PROFIT_WATCHER_STARTED",
    message: "Auto sell workers were started from UI"
  });

  return getTradingStatus();
}

export function stopProfitWatcher() {
  state.profitEnabled = false;
  state.stoppedAt = new Date().toISOString();
  setRuntimeFlag("profit_enabled", false);

  killWorker("profit-low");
  killWorker("profit-high");
  createBotLog({
    event: "PROFIT_WATCHER_STOPPED",
    message: "Auto sell was stopped from UI"
  });

  return getTradingStatus();
}

export function startTrading() {
  startCopyTrading();
  return startProfitWatcher();
}

export function stopTrading() {
  stopCopyTrading();
  return stopProfitWatcher();
}

export function startMirrorTrading() {
  state.mirrorEnabled = true;
  setRuntimeFlag("mirror_enabled", true);

  spawnManagedProcess("mirror", "worker:mirror");
  createBotLog({
    event: "MIRROR_TRADING_STARTED",
    message: "Mirror trading was started from UI"
  });

  return getMirrorStatus();
}

export function stopMirrorTrading() {
  state.mirrorEnabled = false;
  setRuntimeFlag("mirror_enabled", false);

  killWorker("mirror");
  createBotLog({
    event: "MIRROR_TRADING_STOPPED",
    message: "Mirror trading was stopped from UI"
  });

  return getMirrorStatus();
}
