import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
  ListStateMachinesCommand,
  SFNClient,
  type HistoryEvent,
} from "@aws-sdk/client-sfn";
import type { AslDefinition, HistoryEvent as CoreHistoryEvent } from "@sfn-lens/core";

export function createSfnClient(): SFNClient {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "eu-north-1";
  // Default provider chain reads AWS_PROFILE (default to personal for this tool).
  if (!process.env.AWS_PROFILE) process.env.AWS_PROFILE = "personal";
  return new SFNClient({ region });
}

export async function resolveExecutionArn(
  client: SFNClient,
  input: { executionArn?: string; stateMachineArn?: string; name?: string },
): Promise<string> {
  if (input.executionArn) return input.executionArn;
  if (!input.stateMachineArn || !input.name) {
    throw new Error("Provide executionArn, or both stateMachineArn and name");
  }
  // List and find by name (API has no GetExecution by name alone without ARN)
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
): Promise<{
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
  definition: AslDefinition;
  history: CoreHistoryEvent[];
}> {
  const desc = await client.send(new DescribeExecutionCommand({ executionArn }));
  if (!desc.stateMachineArn || !desc.name || !desc.status) {
    throw new Error(`Incomplete DescribeExecution for ${executionArn}`);
  }

  const sm = await client.send(
    new DescribeStateMachineCommand({ stateMachineArn: desc.stateMachineArn }),
  );
  if (!sm.definition) throw new Error("State machine definition missing");
  const definition = JSON.parse(sm.definition) as AslDefinition;

  const history = await fetchAllHistory(client, executionArn);

  return {
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
    definition,
    history: history.map(toCoreEvent),
  };
}

export async function listRecentExecutions(
  client: SFNClient,
  params: {
    stateMachineArn?: string;
    statusFilter?: string;
    maxResults?: number;
  },
): Promise<
  Array<{
    executionArn: string;
    name: string;
    status: string;
    startDate?: string;
    stopDate?: string;
    stateMachineArn: string;
  }>
> {
  let stateMachineArn = params.stateMachineArn;
  if (!stateMachineArn) {
    const machines = await client.send(new ListStateMachinesCommand({ maxResults: 50 }));
    const first = machines.stateMachines?.[0]?.stateMachineArn;
    if (!first) return [];
    stateMachineArn = first;
  }

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
      maxResults: params.maxResults ?? 20,
    }),
  );

  return (out.executions ?? []).map((e) => ({
    executionArn: e.executionArn!,
    name: e.name!,
    status: e.status!,
    startDate: e.startDate?.toISOString(),
    stopDate: e.stopDate?.toISOString(),
    stateMachineArn: stateMachineArn!,
  }));
}

async function fetchAllHistory(
  client: SFNClient,
  executionArn: string,
  hardCap = 5000,
): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new GetExecutionHistoryCommand({
        executionArn,
        includeExecutionData: true,
        maxResults: 1000,
        nextToken,
        reverseOrder: false,
      }),
    );
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
    if (events.length >= hardCap) break;
  } while (nextToken);
  return events;
}

function toCoreEvent(e: HistoryEvent): CoreHistoryEvent {
  const base: CoreHistoryEvent = {
    id: e.id ?? 0,
    type: e.type ?? "Unknown",
    timestamp: e.timestamp ?? new Date(),
    previousEventId: e.previousEventId,
  };
  // Copy detail blobs
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
): { input?: unknown; output?: unknown; error?: string; cause?: string; retries: Array<{ error?: string; cause?: string; at?: string }> } {
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

function isNearState(history: CoreHistoryEvent[], event: CoreHistoryEvent, stateName: string): boolean {
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
