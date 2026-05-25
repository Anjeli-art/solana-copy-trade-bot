import { useCallback, useEffect, useRef, useState } from "react";
import { deleteAllLogs, deleteLog, deleteLogsByEvent, getLogEvents, getLogs } from "../api/client";
import type { BotLog } from "../types";

type SetApiError = (message: string) => void;

export function useLogs(setApiError: SetApiError) {
  const [logs, setLogs] = useState<BotLog[]>([]);
  const [logEvents, setLogEvents] = useState<string[]>([]);
  const [logEventFilter, setLogEventFilter] = useState("all");
  const [isLogsRefreshing, setIsLogsRefreshing] = useState(false);
  const didLoadLogEvents = useRef(false);

  const refreshLogEvents = useCallback(async () => {
    if (didLoadLogEvents.current) {
      return;
    }

    didLoadLogEvents.current = true;
    try {
      const nextEvents = await getLogEvents();
      setLogEvents(nextEvents);
    } catch (fetchError) {
      didLoadLogEvents.current = false;
      setApiError(fetchError instanceof Error ? fetchError.message : "Failed to load log events");
    }
  }, [setApiError]);

  const refreshLogs = useCallback(
    async (eventFilter = logEventFilter) => {
      try {
        setApiError("");
        setIsLogsRefreshing(true);
        const nextLogs = await getLogs(1000, eventFilter === "all" ? undefined : eventFilter);
        setLogs(nextLogs);
      } catch (fetchError) {
        setApiError(fetchError instanceof Error ? fetchError.message : "Failed to load logs");
      } finally {
        setIsLogsRefreshing(false);
      }
    },
    [logEventFilter, setApiError]
  );

  useEffect(() => {
    refreshLogEvents();
  }, [refreshLogEvents]);

  useEffect(() => {
    refreshLogs();
    const logsTimer = window.setInterval(() => {
      refreshLogs();
    }, 20000);

    return () => {
      window.clearInterval(logsTimer);
    };
  }, [refreshLogs]);

  const removeLog = useCallback(
    async (id: string) => {
      try {
        setApiError("");
        await deleteLog(id);
        setLogs((current) => current.filter((log) => log.id !== id));
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to delete log");
      }
    },
    [setApiError]
  );

  const removeLogsByEvent = useCallback(
    async (event: string) => {
      try {
        setApiError("");
        if (event === "all") {
          await deleteAllLogs();
          setLogs([]);
        } else {
          await deleteLogsByEvent(event);
          setLogs((current) => current.filter((log) => log.event !== event));
          // Do NOT remove event from logEvents — list stays intact until refresh
        }
      } catch (submitError) {
        setApiError(submitError instanceof Error ? submitError.message : "Failed to delete logs");
      }
    },
    [setApiError]
  );

  const changeLogEventFilter = useCallback((nextEvent: string) => {
    setLogEventFilter(nextEvent);
  }, []);

  return {
    logs,
    logEvents,
    logEventFilter,
    isLogsRefreshing,
    refreshLogs,
    removeLog,
    removeLogsByEvent,
    changeLogEventFilter
  };
}
