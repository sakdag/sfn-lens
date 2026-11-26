/** Amazon States Language state machine definition (subset we care about). */
export interface AslDefinition {
  Comment?: string;
  StartAt: string;
  States: Record<string, AslState>;
  TimeoutSeconds?: number;
}

export type AslStateType =
  | "Task"
  | "Pass"
  | "Wait"
  | "Succeed"
  | "Fail"
  | "Choice"
  | "Parallel"
  | "Map";

export interface AslRetry {
  ErrorEquals: string[];
  IntervalSeconds?: number;
  MaxAttempts?: number;
  BackoffRate?: number;
}

export interface AslCatch {
  ErrorEquals: string[];
  Next: string;
  ResultPath?: string;
}

export interface AslChoiceRule {
  Variable?: string;
  Next?: string;
  And?: AslChoiceRule[];
  Or?: AslChoiceRule[];
  Not?: AslChoiceRule;
  BooleanEquals?: boolean;
  StringEquals?: string;
  NumericEquals?: number;
  NumericGreaterThan?: number;
  NumericLessThan?: number;
  IsPresent?: boolean;
  Default?: never;
}

export interface AslState {
  Type: string;
  Comment?: string;
  Next?: string;
  End?: boolean;
  Resource?: string;
  Parameters?: unknown;
  Result?: unknown;
  ResultPath?: string;
  InputPath?: string;
  OutputPath?: string;
  TimeoutSeconds?: number;
  HeartbeatSeconds?: number;
  Retry?: AslRetry[];
  Catch?: AslCatch[];
  Choices?: Array<AslChoiceRule & { Next: string }>;
  Default?: string;
  Branches?: AslDefinition[];
  Iterator?: AslDefinition;
  ItemProcessor?: AslDefinition;
  ItemsPath?: string;
  MaxConcurrency?: number;
  Cause?: string;
  Error?: string;
  Seconds?: number;
  Timestamp?: string;
}

export type StateRunStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "CAUGHT"
  | "RETRIED"
  | "RUNNING"
  | "NOT_RUN"
  | "ABORTED";

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  /** Nesting path for Parallel/Map children, e.g. "Parallel:0/Map" */
  parentId?: string;
  branchIndex?: number;
  resource?: string;
  retry?: AslRetry[];
  catchTargets?: string[];
  isStart?: boolean;
  isTerminal?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: "next" | "choice" | "default" | "catch" | "parallel" | "map";
}

export interface WorkflowGraph {
  startAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface StateOverlay {
  name: string;
  status: StateRunStatus;
  enteredAt?: string;
  exitedAt?: string;
  durationMs?: number;
  error?: string;
  cause?: string;
  retryCount: number;
  /** True if a Catch transition handled a failure for this state. */
  caught: boolean;
}

export interface ExecutionOverlay {
  status: string;
  startDate?: string;
  stopDate?: string;
  durationMs?: number;
  error?: string;
  cause?: string;
  states: Record<string, StateOverlay>;
  /** Ordered state names that actually ran (entered). */
  path: string[];
  failedState?: string;
}

export interface StateSummary {
  name: string;
  type: string;
  status: StateRunStatus;
  durationMs?: number;
  error?: string;
  retryCount?: number;
  caught?: boolean;
}

/** Compact summary returned to the model (not the full history). */
export interface ExecutionSummary {
  executionArn: string;
  name: string;
  status: string;
  stateMachineArn: string;
  startDate?: string;
  stopDate?: string;
  durationMs?: number;
  failedState?: string;
  error?: string;
  cause?: string;
  retryCount: number;
  path: string[];
  statesSummary: StateSummary[];
  uiHint: string;
  /** True when history was capped and may omit middle events. */
  historyTruncated?: boolean;
}

/** Full payload for the UI (graph + overlays + redacted metadata). */
export interface ExecutionViewModel {
  summary: ExecutionSummary;
  graph: WorkflowGraph;
  overlay: ExecutionOverlay;
  definitionComment?: string;
}

export interface StateDetail {
  name: string;
  type?: string;
  status: StateRunStatus;
  enteredAt?: string;
  exitedAt?: string;
  durationMs?: number;
  error?: string;
  cause?: string;
  retryCount: number;
  caught: boolean;
  input?: unknown;
  output?: unknown;
  retries: Array<{ error?: string; cause?: string; at?: string }>;
}

export interface ExecutionCompareResult {
  leftArn: string;
  rightArn: string;
  leftStatus: string;
  rightStatus: string;
  firstDivergingState?: string;
  pathDiff: {
    onlyLeft: string[];
    onlyRight: string[];
    shared: string[];
  };
  durationDiffMs?: number;
  stateDurationDeltas: Array<{
    name: string;
    leftMs?: number;
    rightMs?: number;
    deltaMs?: number;
  }>;
  summaryText: string;
}

/** Fixture for offline / CI use (synthetic or recorded). */
export interface ExecutionFixture {
  id: string;
  description: string;
  /** `synthetic` = generated locally; `recorded` = from a real GetExecutionHistory. */
  source?: "synthetic" | "recorded";
  faultId?: string;
  execution: {
    executionArn: string;
    name: string;
    status: string;
    stateMachineArn: string;
    startDate: string;
    stopDate?: string;
    input?: string;
    output?: string;
    error?: string;
    cause?: string;
  };
  definition: AslDefinition;
  history: HistoryEvent[];
  /** Optional per-state input/output captured at record time. */
  stateDetails?: Record<
    string,
    { input?: unknown; output?: unknown; error?: string; cause?: string }
  >;
  gold?: {
    failedState?: string;
    errorClass?: string;
    rootCause?: string;
  };
}

/** Subset of GetExecutionHistory event shape. */
export interface HistoryEvent {
  id: number;
  timestamp: string | Date;
  type: string;
  previousEventId?: number;
  [key: string]: unknown;
}
