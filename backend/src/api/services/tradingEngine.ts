import path from "path";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { createBotLog } from "./logs";

type ManagedProcess = {
  name: "copy" | "profit-low" | "profit-high";
  process: ChildProcessWithoutNullStreams;
};

type TradingEngineState = {
  copyEnabled: boolean;
  profitEnabled: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
};

const backendRoot = path.resolve(__dirname, "../../..");
const state: TradingEngineState = {
  copyEnabled: false,
  profitEnabled: false
};
const processes: ManagedProcess[] = [];

function appendLog(name: string, chunk: Buffer) {
  const text = chunk.toString("utf8").trim();
  if (!text) {
    return;
  }

  for (const line of text.split("\n")) {
    console.log(`[trading:${name}] ${line}`);
  }
}

function isProfitProcess(name: ManagedProcess["name"]) {
  return name === "profit-low" || name === "profit-high";
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

  child.stdout.on("data", (chunk) => appendLog(name, chunk));
  child.stderr.on("data", (chunk) => appendLog(name, chunk));
  child.on("exit", (code, signal) => {
    const index = processes.findIndex((item) => item.process.pid === child.pid);
    if (index >= 0) {
      processes.splice(index, 1);
    }

    const wasEnabled = name === "copy" ? state.copyEnabled : state.profitEnabled;
    if (name === "copy") {
      state.copyEnabled = false;
    } else if (!processes.some((item) => isProfitProcess(item.name))) {
      state.profitEnabled = false;
    }

    if (wasEnabled) {
      state.stoppedAt = new Date().toISOString();
      state.lastError = `${name} trading process stopped unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}`;
      createBotLog({
        level: "error",
        event: "TRADING_PROCESS_STOPPED",
        message: state.lastError,
        metadata: { process: name, code, signal }
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

export function startCopyTrading() {
  state.copyEnabled = true;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = undefined;
  state.lastError = undefined;

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

  for (const item of processes.filter((process) => process.name === "copy")) {
    item.process.kill("SIGTERM");
  }
  createBotLog({
    event: "COPY_TRADING_STOPPED",
    message: "Auto buy was stopped from UI"
  });

  return getTradingStatus();
}

export function startProfitWatcher() {
  state.profitEnabled = true;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = undefined;
  state.lastError = undefined;

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

  for (const item of processes.filter((process) => isProfitProcess(process.name))) {
    item.process.kill("SIGTERM");
  }
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
