import type {
  AslDefinition,
  ExecutionOverlay,
  ExecutionSummary,
  ExecutionViewModel,
  StateSummary,
  WorkflowGraph,
} from "./types.js";
import { aslToGraph } from "./asl-graph.js";
import { overlayFromHistory } from "./history-overlay.js";
import type { HistoryEvent } from "./types.js";

const UI_HINT =
  "A graph of this execution is shown in the UI. The user can click a state to inspect input, output, retries, and errors. After they focus a state, prefer answering from that state's data.";

export function buildExecutionSummary(params: {
  executionArn: string;
  name: string;
  status: string;
  stateMachineArn: string;
  startDate?: string;
  stopDate?: string;
  overlay: ExecutionOverlay;
  graph: WorkflowGraph;
}): ExecutionSummary {
  const { overlay, graph } = params;
  const statesSummary: StateSummary[] = graph.nodes
    .filter((n) => !n.parentId)
    .map((n) => {
      const o = overlay.states[n.name];
      return {
        name: n.name,
        type: n.type,
        status: o?.status ?? "NOT_RUN",
        durationMs: o?.durationMs,
        error: o?.error,
        retryCount: o?.retryCount,
        caught: o?.caught,
      };
    });

  // Include nested nodes that actually ran
  for (const n of graph.nodes.filter((x) => x.parentId)) {
    const o = overlay.states[n.name];
    if (!o || o.status === "NOT_RUN") continue;
    if (statesSummary.some((s) => s.name === n.name)) continue;
    statesSummary.push({
      name: n.name,
      type: n.type,
      status: o.status,
      durationMs: o.durationMs,
      error: o.error,
      retryCount: o.retryCount,
      caught: o.caught,
    });
  }

  const retryCount = Object.values(overlay.states).reduce((a, s) => a + s.retryCount, 0);
  const cause = truncate(overlay.cause ?? overlay.states[overlay.failedState ?? ""]?.cause, 400);
  const error = overlay.error ?? overlay.states[overlay.failedState ?? ""]?.error;

  return {
    executionArn: params.executionArn,
    name: params.name,
    status: params.status,
    stateMachineArn: params.stateMachineArn,
    startDate: params.startDate ?? overlay.startDate,
    stopDate: params.stopDate ?? overlay.stopDate,
    durationMs: overlay.durationMs,
    failedState: overlay.failedState,
    error,
    cause,
    retryCount,
    path: overlay.path,
    statesSummary,
    uiHint: UI_HINT,
  };
}

export function buildViewModel(params: {
  executionArn: string;
  name: string;
  status: string;
  stateMachineArn: string;
  startDate?: string;
  stopDate?: string;
  error?: string;
  cause?: string;
  definition: AslDefinition;
  history: HistoryEvent[];
}): ExecutionViewModel {
  const graph = aslToGraph(params.definition);
  const overlay = overlayFromHistory(params.history, {
    status: params.status,
    startDate: params.startDate,
    stopDate: params.stopDate,
    error: params.error,
    cause: params.cause,
  });
  const summary = buildExecutionSummary({
    executionArn: params.executionArn,
    name: params.name,
    status: params.status,
    stateMachineArn: params.stateMachineArn,
    startDate: params.startDate,
    stopDate: params.stopDate,
    overlay,
    graph,
  });
  return {
    summary,
    graph,
    overlay,
    definitionComment: params.definition.Comment,
  };
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
