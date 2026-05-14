import path from "path";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { createBotLog } from "./logs";

type ManagedProcess = {
  name: "copy" | "profit";
  process: ChildProcessWithoutNullStreams;
};

type TradingEngineState = {
  enabled: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
};

const backendRoot = path.resolve(__dirname, "../../..");
const state: TradingEngineState = {
  enabled: false
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

function spawnManagedProcess(name: ManagedProcess["name"], script: string) {
  const child = spawn("npm", ["run", script], {
    cwd: backendRoot,
    env: process.env
  });

  child.stdout.on("data", (chunk) => appendLog(name, chunk));
  child.stderr.on("data", (chunk) => appendLog(name, chunk));
  child.on("exit", (code, signal) => {
    const index = processes.findIndex((item) => item.process.pid === child.pid);
    if (index >= 0) {
      processes.splice(index, 1);
    }

    if (state.enabled) {
      state.enabled = false;
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
    ...state,
    processes: processes.map((item) => ({
      name: item.name,
      pid: item.process.pid
    }))
  };
}

export function startTrading() {
  if (state.enabled) {
    return getTradingStatus();
  }

  state.enabled = true;
  state.startedAt = new Date().toISOString();
  state.stoppedAt = undefined;
  state.lastError = undefined;

  spawnManagedProcess("copy", "worker:copy");
  spawnManagedProcess("profit", "worker:profit");
  createBotLog({
    event: "TRADING_STARTED",
    message: "Trading was started from UI"
  });

  return getTradingStatus();
}

export function stopTrading() {
  state.enabled = false;
  state.stoppedAt = new Date().toISOString();

  for (const item of [...processes]) {
    item.process.kill("SIGTERM");
  }
  processes.splice(0, processes.length);
  createBotLog({
    event: "TRADING_STOPPED",
    message: "Trading was stopped from UI"
  });

  return getTradingStatus();
}
