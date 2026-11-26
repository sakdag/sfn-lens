import type {
  ExecutionOverlay,
  HistoryEvent,
  StateOverlay,
  StateRunStatus,
} from "./types.js";

function ts(event: HistoryEvent): string {
  const t = event.timestamp;
  return t instanceof Date ? t.toISOString() : String(t);
}

function msBetween(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) ? d : undefined;
}

function ensureState(map: Record<string, StateOverlay>, name: string): StateOverlay {
  if (!map[name]) {
    map[name] = {
      name,
      status: "NOT_RUN",
      retryCount: 0,
      caught: false,
    };
  }
  return map[name]!;
}

/**
 * Build a per-state overlay from GetExecutionHistory events.
 * Handles Task/Pass/Wait/Choice/Succeed/Fail/Parallel/Map enter-exit and failures.
 */
export function overlayFromHistory(
  history: HistoryEvent[],
  executionMeta: {
    status: string;
    startDate?: string;
    stopDate?: string;
    error?: string;
    cause?: string;
  },
): ExecutionOverlay {
  const states: Record<string, StateOverlay> = {};
  const path: string[] = [];
  let failedState: string | undefined;

  const sorted = [...history].sort((a, b) => a.id - b.id);

  for (const event of sorted) {
    const type = event.type;
    const details = pickDetails(event);

    if (type.endsWith("StateEntered") || type === "MapStateStarted" || type === "ParallelStateStarted") {
      const name = details.stateEnteredName ?? details.name;
      if (!name) continue;
      const s = ensureState(states, name);
      if (!s.enteredAt) s.enteredAt = ts(event);
      if (s.status === "NOT_RUN") s.status = "RUNNING";
      if (!path.includes(name)) path.push(name);
      continue;
    }

    if (type.endsWith("StateExited") || type === "MapStateSucceeded" || type === "ParallelStateSucceeded") {
      const name = details.stateExitedName ?? details.name;
      if (!name) continue;
      const s = ensureState(states, name);
      s.exitedAt = ts(event);
      s.durationMs = msBetween(s.enteredAt, s.exitedAt);
      if (s.status === "RUNNING" || s.status === "RETRIED") s.status = "SUCCEEDED";
      continue;
    }

    if (
      type === "TaskFailed" ||
      type === "TaskTimedOut" ||
      type === "ActivityFailed" ||
      type === "ActivityTimedOut" ||
      type === "LambdaFunctionFailed" ||
      type === "LambdaFunctionTimedOut" ||
      type.endsWith("Failed") ||
      type.endsWith("TimedOut")
    ) {
      const name = resolveFailedStateName(event, sorted, details);
      if (!name) continue;
      const s = ensureState(states, name);
      s.error = details.error ?? type;
      s.cause = truncate(details.cause, 500);
      // Retries: TaskFailed often precedes TaskStateExited or Catch; count retries
      if (type === "TaskFailed" || type === "LambdaFunctionFailed" || type === "TaskTimedOut") {
        s.retryCount += 1;
        s.status = "RETRIED";
      } else {
        s.status = "FAILED";
      }
      failedState = name;
      continue;
    }

    if (type === "ExecutionFailed" || type === "ExecutionTimedOut" || type === "ExecutionAborted") {
      if (details.error) executionMeta = { ...executionMeta, error: details.error };
      if (details.cause) executionMeta = { ...executionMeta, cause: truncate(details.cause, 500) };
      continue;
    }
  }

  // Promote last RETRIED without success to FAILED; mark Catch survivors
  for (const s of Object.values(states)) {
    if (s.status === "RETRIED") {
      s.status = "FAILED";
      failedState = failedState ?? s.name;
    }
    if (s.status === "RUNNING" && executionMeta.status !== "RUNNING") {
      s.status = mapExecStatus(executionMeta.status);
    }
  }

  // Detect catch: state failed but execution continued to another state after it
  markCaughtStates(states, path, executionMeta.status);

  if (executionMeta.status === "FAILED" || executionMeta.status === "TIMED_OUT") {
    // Prefer last failed in path
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i]!;
      const st = states[n];
      if (st && (st.status === "FAILED" || st.status === "CAUGHT")) {
        if (st.status === "FAILED") failedState = n;
        break;
      }
    }
  }

  return {
    status: executionMeta.status,
    startDate: executionMeta.startDate,
    stopDate: executionMeta.stopDate,
    durationMs: msBetween(executionMeta.startDate, executionMeta.stopDate),
    error: executionMeta.error,
    cause: truncate(executionMeta.cause, 500),
    states,
    path,
    failedState,
  };
}

function markCaughtStates(
  states: Record<string, StateOverlay>,
  path: string[],
  execStatus: string,
): void {
  if (execStatus === "SUCCEEDED") {
    for (const s of Object.values(states)) {
      if (s.status === "FAILED" && s.error) {
        s.status = "CAUGHT";
        s.caught = true;
      }
    }
  } else {
    // Intermediate failures that are not the terminal failed state
    const lastFailed = [...path].reverse().find((n) => states[n]?.status === "FAILED");
    for (const name of path) {
      const s = states[name];
      if (!s || s.status !== "FAILED") continue;
      if (name !== lastFailed && s.error) {
        s.status = "CAUGHT";
        s.caught = true;
      }
    }
  }
}

function mapExecStatus(status: string): StateRunStatus {
  switch (status) {
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "FAILED":
    case "TIMED_OUT":
      return "FAILED";
    case "ABORTED":
      return "ABORTED";
    case "RUNNING":
      return "RUNNING";
    default:
      return "NOT_RUN";
  }
}

function pickDetails(event: HistoryEvent): {
  name?: string;
  stateEnteredName?: string;
  stateExitedName?: string;
  error?: string;
  cause?: string;
} {
  const keys = Object.keys(event).filter((k) => k.endsWith("EventDetails") || k.endsWith("FailedEventDetails"));
  for (const k of keys) {
    const d = event[k] as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") continue;
    return {
      name: typeof d.name === "string" ? d.name : undefined,
      stateEnteredName: typeof d.name === "string" ? d.name : undefined,
      stateExitedName: typeof d.name === "string" ? d.name : undefined,
      error: typeof d.error === "string" ? d.error : undefined,
      cause: typeof d.cause === "string" ? d.cause : undefined,
    };
  }

  // Also check stateEnteredEventDetails / stateExitedEventDetails explicitly
  const entered = event.stateEnteredEventDetails as { name?: string } | undefined;
  if (entered?.name) return { stateEnteredName: entered.name, name: entered.name };
  const exited = event.stateExitedEventDetails as { name?: string } | undefined;
  if (exited?.name) return { stateExitedName: exited.name, name: exited.name };

  return {};
}

function resolveFailedStateName(
  event: HistoryEvent,
  all: HistoryEvent[],
  details: { name?: string },
): string | undefined {
  if (details.name) return details.name;
  // Walk back to nearest StateEntered
  for (let i = all.indexOf(event) - 1; i >= 0; i--) {
    const prev = all[i]!;
    if (String(prev.type).endsWith("StateEntered")) {
      const d = pickDetails(prev);
      return d.stateEnteredName ?? d.name;
    }
  }
  return undefined;
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function emptyOverlayForGraph(stateNames: string[]): ExecutionOverlay {
  const states: Record<string, StateOverlay> = {};
  for (const name of stateNames) {
    states[name] = { name, status: "NOT_RUN", retryCount: 0, caught: false };
  }
  return {
    status: "UNKNOWN",
    states,
    path: [],
  };
}
