export type StateRunStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "CAUGHT"
  | "RETRIED"
  | "RUNNING"
  | "NOT_RUN"
  | "ABORTED";

export type ConsoleTab = "graph" | "executions" | "definition";

export interface LaidOutNode {
  id: string;
  name: string;
  type: string;
  parentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isStart?: boolean;
  isTerminal?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: string;
}

export interface StateOverlay {
  name: string;
  status: StateRunStatus;
  durationMs?: number;
  error?: string;
  cause?: string;
  retryCount: number;
  caught: boolean;
}

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
  statesSummary: Array<{
    name: string;
    type: string;
    status: StateRunStatus;
    durationMs?: number;
    error?: string;
  }>;
}

export interface Capabilities {
  redriveEnabled?: boolean;
  fixtureMode?: boolean;
}

export interface ShowExecutionPayload {
  view?: "execution" | "executions" | "definition";
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
  statesSummary: ExecutionSummary["statesSummary"];
  uiHint?: string;
  graph: { nodes: LaidOutNode[]; edges: GraphEdge[]; width: number; height: number };
  overlay: {
    status: string;
    states: Record<string, StateOverlay>;
    path: string[];
    failedState?: string;
  };
  definitionText?: string;
  capabilities?: Capabilities;
  redrivable?: boolean;
  redriveCount?: number;
  redriveDate?: string;
  redriveStatus?: string;
}

export interface ExecutionListItem {
  executionArn: string;
  name: string;
  status: string;
  startDate?: string;
  stopDate?: string;
  stateMachineArn: string;
  fixtureId?: string;
  description?: string;
}

export interface ExecutionsPayload {
  view: "executions";
  mode?: string;
  stateMachineArn: string;
  filters?: {
    statusFilter?: string;
    nameContains?: string;
  };
  executions: ExecutionListItem[];
  nextToken?: string;
  capabilities?: Capabilities;
}

export interface DefinitionPayload {
  view: "definition";
  stateMachineArn: string;
  name?: string;
  status?: string;
  type?: string;
  roleArn?: string;
  creationDate?: string;
  definitionText: string;
  capabilities?: Capabilities;
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
