import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
  ListStateMachinesCommand,
  RedriveExecutionCommand,
  SFNClient,
  type HistoryEvent,
} from "@aws-sdk/client-sfn";
import type { AslDefinition, HistoryEvent as CoreHistoryEvent } from "@sfn-lens/core";
import { randomUUID } from "node:crypto";

const HISTORY_HARD_CAP = 5000;
const EXECUTION_CACHE_TTL_MS = 60_000;

export type LiveExecution = {
  executionArn: string;
  name: string;
  status: string;
  stateMachineArn: string;
  startDate?: string;
  stopDate?: string;
  error?: string;
  cause?: string;
  input?: string;
  output?: string;
  redriveCount: number;
  redriveDate?: string;
  redriveStatus?: string;
  definition: AslDefinition;
  history: CoreHistoryEvent[];
  historyTruncated: boolean;
};

type CacheEntry = { fetchedAt: number; value: LiveExecution };

const executionCache = new Map<string, CacheEntry>();

/**
 * Use the AWS SDK default credential + region chain.
 * Do not force AWS_PROFILE or a hard-coded region — that breaks SSO, env keys,
 * and anyone whose profile is not named "personal".
 */
export function createSfnClient(): SFNClient {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  return new SFNClient(region ? { region } : {});
}

export function invalidateExecutionCache(executionArn?: string): void {
  if (executionArn) executionCache.delete(executionArn);
  else executionCache.clear();
}

export async function resolveExecutionArn(
  client: SFNClient,
  input: { executionArn?: string; stateMachineArn?: string; name?: string },
): Promise<string> {
  if (input.executionArn) return input.executionArn;
  if (!input.stateMachineArn || !input.name) {
    throw new Error("Provide executionArn, or both stateMachineArn and name");
  }
  const listed = await client.send(
    new ListExecutionsCommand({
      stateMachineArn: input.stateMachineArn,
      maxResults: 100,
    }),
  );
  const match = listed.executions?.find((e) => e.name === input.name);
  if (!match?.executionArn) {
    throw new Error(`Execution named "${input.name}" not found on ${input.stateMachineArn}`);
  }
  return match.executionArn;
}

export async function loadLiveExecution(
  client: SFNClient,
  executionArn: string,
  opts?: { bypassCache?: boolean },
): Promise<LiveExecution> {
  if (!opts?.bypassCache) {
    const hit = executionCache.get(executionArn);
    if (hit && Date.now() - hit.fetchedAt < EXECUTION_CACHE_TTL_MS) {
      return hit.value;
    }
  }

  const desc = await client.send(new DescribeExecutionCommand({ executionArn }));
  if (!desc.stateMachineArn || !desc.name || !desc.status) {
    throw new Error(`Incomplete DescribeExecution for ${executionArn}`);
  }

  const sm = await client.send(
    new DescribeStateMachineCommand({ stateMachineArn: desc.stateMachineArn }),
  );
  if (!sm.definition) throw new Error("State machine definition missing");
  const definition = JSON.parse(sm.definition) as AslDefinition;

  const { events, truncated } = await fetchHistoryPreferTail(client, executionArn);

  const value: LiveExecution = {
    executionArn,
    name: desc.name,
    status: desc.status,
    stateMachineArn: desc.stateMachineArn,
    startDate: desc.startDate?.toISOString(),
    stopDate: desc.stopDate?.toISOString(),
    error: desc.error,
    cause: desc.cause,
    input: desc.input,
    output: desc.output,
    redriveCount: desc.redriveCount ?? 0,
    redriveDate: desc.redriveDate?.toISOString(),
    redriveStatus: desc.redriveStatus,
    definition,
    history: events.map(toCoreEvent),
    historyTruncated: truncated,
  };

  executionCache.set(executionArn, { fetchedAt: Date.now(), value });
  return value;
}

export type ExecutionListItem = {
  executionArn: string;
  name: string;
  status: string;
  startDate?: string;
  stopDate?: string;
  stateMachineArn: string;
};

export async function listRecentExecutions(
  client: SFNClient,
  params: {
    stateMachineArn?: string;
    statusFilter?: string;
    maxResults?: number;
    nameContains?: string;
    nextToken?: string;
  },
): Promise<{
  executions: ExecutionListItem[];
  nextToken?: string;
  stateMachineArn: string;
}> {
  let stateMachineArn = params.stateMachineArn;
  if (!stateMachineArn) {
    const machines = await client.send(new ListStateMachinesCommand({ maxResults: 50 }));
    const first = machines.stateMachines?.[0]?.stateMachineArn;
    if (!first) return { executions: [], stateMachineArn: "" };
    stateMachineArn = first;
  }

  const apiMax = params.nameContains
    ? Math.min(100, Math.max(params.maxResults ?? 50, 50))
    : (params.maxResults ?? 25);

  const out = await client.send(
    new ListExecutionsCommand({
      stateMachineArn,
      statusFilter: params.statusFilter as
        | "RUNNING"
        | "SUCCEEDED"
        | "FAILED"
        | "TIMED_OUT"
        | "ABORTED"
        | "PENDING_REDRIVE"
        | undefined,
      maxResults: apiMax,
      nextToken: params.nextToken,
    }),
  );

  let executions: ExecutionListItem[] = (out.executions ?? []).map((e) => ({
    executionArn: e.executionArn!,
    name: e.name!,
    status: e.status!,
    startDate: e.startDate?.toISOString(),
    stopDate: e.stopDate?.toISOString(),
    stateMachineArn: stateMachineArn!,
  }));

  if (params.nameContains?.trim()) {
    const q = params.nameContains.trim().toLowerCase();
    executions = executions.filter((e) => e.name.toLowerCase().includes(q));
    if (params.maxResults) executions = executions.slice(0, params.maxResults);
  }

  return {
    executions,
    nextToken: out.nextToken,
    stateMachineArn,
  };
}

export async function describeStateMachineDetails(
  client: SFNClient,
  stateMachineArn: string,
): Promise<{
  stateMachineArn: string;
  name: string;
  status?: string;
  type?: string;
  roleArn?: string;
  creationDate?: string;
  definition: AslDefinition;
  definitionText: string;
}> {
  const sm = await client.send(new DescribeStateMachineCommand({ stateMachineArn }));
  if (!sm.definition || !sm.stateMachineArn || !sm.name) {
    throw new Error(`Incomplete DescribeStateMachine for ${stateMachineArn}`);
  }
  let definition: AslDefinition;
  try {
    definition = JSON.parse(sm.definition) as AslDefinition;
  } catch {
    throw new Error("State machine definition is not valid JSON");
  }
  return {
    stateMachineArn: sm.stateMachineArn,
    name: sm.name,
    status: sm.status,
    type: sm.type,
    roleArn: sm.roleArn,
    creationDate: sm.creationDate?.toISOString(),
    definition,
    definitionText: JSON.stringify(definition, null, 2),
  };
}

export async function redriveExecution(
  client: SFNClient,
  executionArn: string,
): Promise<{ executionArn: string; redriveDate: string }> {
  invalidateExecutionCache(executionArn);
  const out = await client.send(
    new RedriveExecutionCommand({
      executionArn,
      clientToken: randomUUID(),
    }),
  );
  return {
    executionArn,
    redriveDate: out.redriveDate?.toISOString() ?? new Date().toISOString(),
  };
}

/**
 * Fetch history preferring the tail so large Map runs still include the failure.
 * When the hard cap truncates, also merge a forward page (start) and set truncated.
 */
export async function fetchHistoryPreferTail(
  client: SFNClient,
  executionArn: string,
  hardCap = HISTORY_HARD_CAP,
): Promise<{ events: HistoryEvent[]; truncated: boolean }> {
  const newest = await fetchHistoryPages(client, executionArn, {
    reverseOrder: true,
    hardCap,
  });

  // reverseOrder pages are newest-first; restore chronological order
  const tailChronological = [...newest.events].reverse();

  if (!newest.truncated) {
    return { events: tailChronological, truncated: false };
  }

  // Truncated: merge head (ExecutionStarted + early path) with capped tail
  const headCap = Math.min(1000, hardCap);
  const oldest = await fetchHistoryPages(client, executionArn, {
    reverseOrder: false,
    hardCap: headCap,
  });

  const byId = new Map<number, HistoryEvent>();
  for (const e of oldest.events) {
    if (e.id != null) byId.set(e.id, e);
  }
  for (const e of tailChronological) {
    if (e.id != null) byId.set(e.id, e);
  }

  const merged = [...byId.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return { events: merged, truncated: true };
}

async function fetchHistoryPages(
  client: SFNClient,
  executionArn: string,
  opts: { reverseOrder: boolean; hardCap: number },
): Promise<{ events: HistoryEvent[]; truncated: boolean }> {
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  let truncated = false;
  do {
    const page = await client.send(
      new GetExecutionHistoryCommand({
        executionArn,
        includeExecutionData: true,
        maxResults: 1000,
        nextToken,
        reverseOrder: opts.reverseOrder,
      }),
    );
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
    if (events.length >= opts.hardCap) {
      if (nextToken) truncated = true;
      break;
    }
  } while (nextToken);
  if (events.length > opts.hardCap) {
    events.length = opts.hardCap;
    truncated = true;
  }
  return { events, truncated };
}

function toCoreEvent(e: HistoryEvent): CoreHistoryEvent {
  const base: CoreHistoryEvent = {
    id: e.id ?? 0,
    type: e.type ?? "Unknown",
    timestamp: e.timestamp ?? new Date(),
    previousEventId: e.previousEventId,
  };
  for (const [k, v] of Object.entries(e)) {
    if (k.endsWith("EventDetails") || k.endsWith("FailedEventDetails")) {
      base[k] = v;
    }
  }
  return base;
}

/** Extract input/output for a state from history enter/exit details when present. */
export function extractStateIo(
  history: CoreHistoryEvent[],
  stateName: string,
): {
  input?: unknown;
  output?: unknown;
  error?: string;
  cause?: string;
  retries: Array<{ error?: string; cause?: string; at?: string }>;
} {
  let input: unknown;
  let output: unknown;
  let error: string | undefined;
  let cause: string | undefined;
  const retries: Array<{ error?: string; cause?: string; at?: string }> = [];

  for (const event of history) {
    const entered = event.stateEnteredEventDetails as { name?: string; input?: string } | undefined;
    if (entered?.name === stateName && entered.input) {
      try {
        input = JSON.parse(entered.input);
      } catch {
        input = entered.input;
      }
    }
    const exited = event.stateExitedEventDetails as { name?: string; output?: string } | undefined;
    if (exited?.name === stateName && exited.output) {
      try {
        output = JSON.parse(exited.output);
      } catch {
        output = exited.output;
      }
    }
    const failed = event.taskFailedEventDetails as { error?: string; cause?: string } | undefined;
    if (failed && isNearState(history, event, stateName)) {
      error = failed.error;
      cause = failed.cause;
      retries.push({
        error: failed.error,
        cause: failed.cause,
        at: String(event.timestamp),
      });
    }
  }

  return { input, output, error, cause, retries };
}

function isNearState(
  history: CoreHistoryEvent[],
  event: CoreHistoryEvent,
  stateName: string,
): boolean {
  const idx = history.indexOf(event);
  for (let i = idx; i >= 0 && i >= idx - 10; i--) {
    const e = history[i]!;
    const entered = e.stateEnteredEventDetails as { name?: string } | undefined;
    if (entered?.name === stateName) return true;
    if (String(e.type).endsWith("StateEntered")) {
      const d = e.stateEnteredEventDetails as { name?: string } | undefined;
      if (d?.name && d.name !== stateName) return false;
    }
  }
  return false;
}
