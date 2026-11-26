import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import {
  buildViewModel,
  compareOverlays,
  layoutGraph,
  redactErrorCause,
  redactValue,
  type ExecutionViewModel,
  type StateDetail,
} from "@sfn-lens/core";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createSfnClient,
  describeStateMachineDetails,
  extractStateIo,
  invalidateExecutionCache,
  listRecentExecutions,
  loadLiveExecution,
  redriveExecution,
  resolveExecutionArn,
} from "./aws.js";
import { redriveEnabled, serverCapabilities } from "./config.js";
import {
  findFixtureByArnOrName,
  fixtureModeEnabled,
  listFixtures,
  loadFixture,
} from "./fixture.js";

const RESOURCE_URI = "ui://sfn-lens/execution.html";
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

const statusFilterSchema = z
  .enum(["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED", "PENDING_REDRIVE"])
  .optional();

const readOnly = { readOnlyHint: true as const };
const destructive = { readOnlyHint: false as const, destructiveHint: true as const };

async function readUiHtml(): Promise<string> {
  const candidates = [
    path.join(DIST_DIR, "ui", "execution.html"),
    path.join(DIST_DIR, "../view-dist/execution.html"),
    path.resolve(DIST_DIR, "../../view/dist/execution.html"),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      /* try next */
    }
  }
  return `<!doctype html><html><body><p>sfn-lens UI not built. Run npm run build.</p></body></html>`;
}

type LoadedExecution = {
  view: ExecutionViewModel;
  history: import("@sfn-lens/core").HistoryEvent[];
  stateDetails?: Record<string, { input?: unknown; output?: unknown; error?: string; cause?: string }>;
  definitionText?: string;
  redriveCount?: number;
  redriveDate?: string;
  redriveStatus?: string;
  historyTruncated?: boolean;
};

async function loadExecutionData(input: {
  executionArn?: string;
  stateMachineArn?: string;
  name?: string;
  fixtureId?: string;
  bypassCache?: boolean;
}): Promise<LoadedExecution> {
  if (fixtureModeEnabled() || input.fixtureId) {
    const fix = input.fixtureId
      ? await loadFixture(input.fixtureId)
      : await findFixtureByArnOrName(input.executionArn, input.name);
    if (!fix) {
      throw new Error(
        input.fixtureId
          ? `Fixture "${input.fixtureId}" not found`
          : "Fixture mode is on but no matching fixture; pass fixtureId",
      );
    }
    const view = buildViewModel({
      executionArn: fix.execution.executionArn,
      name: fix.execution.name,
      status: fix.execution.status,
      stateMachineArn: fix.execution.stateMachineArn,
      startDate: fix.execution.startDate,
      stopDate: fix.execution.stopDate,
      error: fix.execution.error,
      cause: fix.execution.cause,
      definition: fix.definition,
      history: fix.history,
    });
    return {
      view,
      history: fix.history,
      stateDetails: fix.stateDetails,
      definitionText: JSON.stringify(fix.definition, null, 2),
    };
  }

  const client = createSfnClient();
  const arn = await resolveExecutionArn(client, input);
  const live = await loadLiveExecution(client, arn, { bypassCache: input.bypassCache });
  const view = buildViewModel({
    executionArn: live.executionArn,
    name: live.name,
    status: live.status,
    stateMachineArn: live.stateMachineArn,
    startDate: live.startDate,
    stopDate: live.stopDate,
    error: live.error,
    cause: live.cause,
    definition: live.definition,
    history: live.history,
    historyTruncated: live.historyTruncated,
  });
  return {
    view,
    history: live.history,
    definitionText: JSON.stringify(live.definition, null, 2),
    redriveCount: live.redriveCount,
    redriveDate: live.redriveDate,
    redriveStatus: live.redriveStatus,
    historyTruncated: live.historyTruncated,
  };
}

function toolText(summary: ExecutionViewModel["summary"]): string {
  const lines = [
    `Execution ${summary.name} — ${summary.status}`,
    summary.failedState ? `Failed state: ${summary.failedState}` : null,
    summary.error ? `Error: ${summary.error}` : null,
    summary.cause ? `Cause: ${summary.cause}` : null,
    `Path: ${summary.path.join(" → ") || "(none)"}`,
    `Duration: ${summary.durationMs ?? "?"} ms`,
    summary.historyTruncated
      ? "Note: history was truncated; failed-state overlay used the execution tail."
      : null,
    summary.uiHint,
  ];
  return lines.filter(Boolean).join("\n");
}

function canRedriveStatus(status: string): boolean {
  return ["FAILED", "TIMED_OUT", "ABORTED"].includes(status);
}

/** Compact payload for the model — no graph / overlay / definition bulk. */
function compactExecutionContent(loaded: LoadedExecution) {
  const { view, redriveCount, redriveDate, redriveStatus, historyTruncated } = loaded;
  return {
    view: "execution" as const,
    ...view.summary,
    historyTruncated: historyTruncated ?? view.summary.historyTruncated,
    redriveCount: redriveCount ?? 0,
    redriveDate,
    redriveStatus,
    capabilities: serverCapabilities(),
    redrivable:
      canRedriveStatus(view.summary.status) && redriveStatus !== "NOT_REDRIVABLE",
  };
}

/** Full UI payload (graph/overlay/definition) — app-only via get_execution_view. */
function uiExecutionContent(loaded: LoadedExecution) {
  const compact = compactExecutionContent(loaded);
  return {
    ...compact,
    graph: layoutGraph(loaded.view.graph),
    overlay: loaded.view.overlay,
    definitionText: loaded.definitionText,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "sfn-lens",
    version: "0.1.0",
  });

  registerAppTool(
    server,
    "show_execution",
    {
      title: "Show Step Functions execution",
      description:
        "Load an AWS Step Functions execution and open the in-chat console (graph, executions list, definition, redrive). This is the only tool that renders the UI — call it once per execution you want to show. Prefer this over dumping raw GetExecutionHistory. Returns a compact summary for the model; the UI loads graph data separately.",
      inputSchema: z.object({
        executionArn: z.string().optional().describe("Full execution ARN"),
        stateMachineArn: z.string().optional().describe("State machine ARN (with name)"),
        name: z.string().optional().describe("Execution name"),
        fixtureId: z.string().optional().describe("Fixture id when using fixture mode"),
      }),
      annotations: readOnly,
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async (args) => {
      const loaded = await loadExecutionData(args);
      const structuredContent = compactExecutionContent(loaded);
      return {
        content: [{ type: "text", text: toolText(loaded.view.summary) }],
        structuredContent,
      };
    },
  );

  registerAppTool(
    server,
    "get_execution_view",
    {
      title: "Get execution view (UI)",
      description:
        "Return graph, overlay, and definition for the in-chat console. App-only — not for the model.",
      inputSchema: z.object({
        executionArn: z.string().optional(),
        stateMachineArn: z.string().optional(),
        name: z.string().optional(),
        fixtureId: z.string().optional(),
      }),
      annotations: readOnly,
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async (args) => {
      const loaded = await loadExecutionData(args);
      const structuredContent = uiExecutionContent(loaded);
      return {
        content: [{ type: "text", text: `UI view for ${loaded.view.summary.name}` }],
        structuredContent,
      };
    },
  );

  registerAppTool(
    server,
    "compare_executions",
    {
      title: "Compare two Step Functions executions",
      description:
        "Compare two executions: path differences, duration deltas, and the first diverging state.",
      inputSchema: z.object({
        leftExecutionArn: z.string().describe("Baseline execution ARN (e.g. last success)"),
        rightExecutionArn: z.string().describe("Execution ARN to compare (e.g. failed run)"),
        leftFixtureId: z.string().optional(),
        rightFixtureId: z.string().optional(),
      }),
      annotations: readOnly,
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async (args) => {
      const left = await loadExecutionData({
        executionArn: args.leftExecutionArn,
        fixtureId: args.leftFixtureId,
      });
      const right = await loadExecutionData({
        executionArn: args.rightExecutionArn,
        fixtureId: args.rightFixtureId,
      });
      const comparison = compareOverlays({
        leftArn: left.view.summary.executionArn,
        rightArn: right.view.summary.executionArn,
        left: left.view.overlay,
        right: right.view.overlay,
      });
      // Model gets comparison + compact right summary; UI loads graph via get_execution_view
      const structuredContent = {
        ...compactExecutionContent(right),
        comparison,
        rightExecutionArn: right.view.summary.executionArn,
        rightFixtureId: args.rightFixtureId,
      };
      return {
        content: [{ type: "text", text: comparison.summaryText }],
        structuredContent,
      };
    },
  );

  registerAppTool(
    server,
    "list_state_machines",
    {
      title: "List Step Functions state machines",
      description:
        "List state machines in the configured AWS account/region (or fixture catalog). Use before list_executions when the ARN is unknown.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      annotations: readOnly,
      _meta: {
        ui: { visibility: ["model"] },
      },
    },
    async (args) => {
      if (fixtureModeEnabled()) {
        const fixtures = await listFixtures();
        const machines = [{ name: "fixtures", stateMachineArn: "fixture", status: "ACTIVE" }];
        return {
          content: [{ type: "text", text: JSON.stringify({ machines, fixtures }, null, 2) }],
          structuredContent: { mode: "fixture", machines, fixtures, capabilities: serverCapabilities() },
        };
      }
      const { ListStateMachinesCommand } = await import("@aws-sdk/client-sfn");
      const client = createSfnClient();
      const out = await client.send(
        new ListStateMachinesCommand({ maxResults: args.maxResults ?? 50 }),
      );
      const machines = (out.stateMachines ?? []).map((m) => ({
        name: m.name,
        stateMachineArn: m.stateMachineArn,
        type: m.type,
        creationDate: m.creationDate?.toISOString(),
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(machines, null, 2) }],
        structuredContent: { mode: "live", machines, capabilities: serverCapabilities() },
      };
    },
  );

  registerAppTool(
    server,
    "list_executions",
    {
      title: "List Step Functions executions",
      description:
        "List executions for a state machine with optional status and name filters. Returns structured data only — do not use this to open the UI. After you pick an execution, call show_execution so the in-chat console opens once.",
      inputSchema: z.object({
        stateMachineArn: z
          .string()
          .optional()
          .describe("State machine ARN (required in live mode)"),
        statusFilter: statusFilterSchema,
        nameContains: z.string().optional().describe("Case-insensitive substring filter on execution name"),
        maxResults: z.number().int().min(1).max(100).optional(),
        nextToken: z.string().optional(),
      }),
      annotations: readOnly,
      _meta: {
        ui: {
          visibility: ["model", "app"],
        },
      },
    },
    async (args) => {
      if (fixtureModeEnabled()) {
        let fixtures = await listFixtures();
        if (args.statusFilter) {
          fixtures = fixtures.filter((f) => f.status === args.statusFilter);
        }
        if (args.nameContains) {
          const q = args.nameContains.toLowerCase();
          fixtures = fixtures.filter((f) => f.id.toLowerCase().includes(q));
        }
        const executions = fixtures.map((f) => ({
          executionArn: `fixture:${f.id}`,
          name: f.id,
          status: f.status,
          stateMachineArn: "fixture",
          fixtureId: f.id,
          description: f.description,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(executions, null, 2) }],
          structuredContent: {
            view: "executions" as const,
            mode: "fixture",
            stateMachineArn: "fixture",
            filters: {
              statusFilter: args.statusFilter,
              nameContains: args.nameContains,
            },
            executions,
            capabilities: serverCapabilities(),
          },
        };
      }
      if (!args.stateMachineArn) {
        throw new Error("stateMachineArn is required in live mode; call list_state_machines first");
      }
      const client = createSfnClient();
      const listed = await listRecentExecutions(client, {
        stateMachineArn: args.stateMachineArn,
        statusFilter: args.statusFilter,
        nameContains: args.nameContains,
        maxResults: args.maxResults ?? 25,
        nextToken: args.nextToken,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(listed.executions, null, 2) }],
        structuredContent: {
          view: "executions" as const,
          mode: "live",
          stateMachineArn: listed.stateMachineArn,
          filters: {
            statusFilter: args.statusFilter,
            nameContains: args.nameContains,
          },
          executions: listed.executions,
          nextToken: listed.nextToken,
          capabilities: serverCapabilities(),
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_definition",
    {
      title: "Get state machine definition",
      description:
        "Fetch the Amazon States Language definition for a state machine (or the machine behind an execution). Returns data only; the Definition tab inside show_execution's console displays it. Prefer show_execution for the interactive UI.",
      inputSchema: z.object({
        stateMachineArn: z.string().optional(),
        executionArn: z.string().optional(),
        fixtureId: z.string().optional(),
      }),
      annotations: readOnly,
      _meta: {
        ui: {
          visibility: ["model", "app"],
        },
      },
    },
    async (args) => {
      if (fixtureModeEnabled() || args.fixtureId) {
        const fixtures = await listFixtures();
        const fix = args.fixtureId
          ? await loadFixture(args.fixtureId)
          : fixtures[0]
            ? await loadFixture(fixtures[0].id)
            : undefined;
        if (!fix) throw new Error("No fixture available for definition");
        const definitionText = JSON.stringify(fix.definition, null, 2);
        return {
          content: [{ type: "text", text: definitionText }],
          structuredContent: {
            view: "definition" as const,
            stateMachineArn: fix.execution.stateMachineArn,
            name: "fixture-definition",
            definitionText,
            capabilities: serverCapabilities(),
          },
        };
      }

      const client = createSfnClient();
      let stateMachineArn = args.stateMachineArn;
      if (!stateMachineArn && args.executionArn) {
        const live = await loadLiveExecution(client, args.executionArn);
        stateMachineArn = live.stateMachineArn;
      }
      if (!stateMachineArn) {
        throw new Error("Provide stateMachineArn or executionArn");
      }
      const details = await describeStateMachineDetails(client, stateMachineArn);
      return {
        content: [{ type: "text", text: details.definitionText }],
        structuredContent: {
          view: "definition" as const,
          stateMachineArn: details.stateMachineArn,
          name: details.name,
          status: details.status,
          type: details.type,
          roleArn: details.roleArn,
          creationDate: details.creationDate,
          definitionText: details.definitionText,
          capabilities: serverCapabilities(),
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_state_detail",
    {
      title: "Get state detail",
      description: "Return redacted input/output/error/retries for one state. App-only.",
      inputSchema: z.object({
        executionArn: z.string().optional(),
        fixtureId: z.string().optional(),
        stateName: z.string(),
        name: z.string().optional(),
      }),
      annotations: readOnly,
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async (args) => {
      const { view, history, stateDetails } = await loadExecutionData(args);
      const overlay = view.overlay.states[args.stateName];
      const fromHistory = extractStateIo(history, args.stateName);
      const fromFixture = stateDetails?.[args.stateName];
      const node = view.graph.nodes.find((n) => n.name === args.stateName);

      const rawError = overlay?.error ?? fromFixture?.error ?? fromHistory.error;
      const rawCause = overlay?.cause ?? fromFixture?.cause ?? fromHistory.cause;

      const detail: StateDetail = {
        name: args.stateName,
        type: node?.type,
        status: overlay?.status ?? "NOT_RUN",
        enteredAt: overlay?.enteredAt,
        exitedAt: overlay?.exitedAt,
        durationMs: overlay?.durationMs,
        error: rawError,
        cause: redactErrorCause(rawCause),
        retryCount: overlay?.retryCount ?? 0,
        caught: overlay?.caught ?? false,
        input: redactValue(fromFixture?.input ?? fromHistory.input),
        output: redactValue(fromFixture?.output ?? fromHistory.output),
        retries: fromHistory.retries.map((r) => ({
          error: r.error,
          cause: redactErrorCause(r.cause),
          at: r.at,
        })),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(detail) }],
        structuredContent: detail as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppTool(
    server,
    "get_history_page",
    {
      title: "Get execution history page",
      description: "Paginated history events for UI drill-down. App-only.",
      inputSchema: z.object({
        executionArn: z.string().optional(),
        fixtureId: z.string().optional(),
        name: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: readOnly,
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async (args) => {
      const { history, historyTruncated } = await loadExecutionData(args);
      const slice = history.slice(args.offset, args.offset + args.limit).map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: e.timestamp,
      }));
      return {
        content: [
          {
            type: "text",
            text: `events ${args.offset}-${args.offset + slice.length} of ${history.length}${
              historyTruncated ? " (truncated)" : ""
            }`,
          },
        ],
        structuredContent: {
          total: history.length,
          offset: args.offset,
          limit: args.limit,
          truncated: historyTruncated ?? false,
          events: slice,
        },
      };
    },
  );

  registerAppTool(
    server,
    "redrive_execution",
    {
      title: "Redrive Step Functions execution",
      description:
        "Redrive a failed/aborted/timed-out Standard workflow from the unsuccessful step. Requires SFN_LENS_ALLOW_REDRIVE=true and confirm=true. App-only; the UI must collect an explicit confirmation click first.",
      inputSchema: z.object({
        executionArn: z.string(),
        confirm: z
          .boolean()
          .describe("Must be true after the user confirms in the UI"),
      }),
      annotations: destructive,
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async (args) => {
      if (!redriveEnabled()) {
        throw new Error(
          "Redrive is disabled. Set SFN_LENS_ALLOW_REDRIVE=true in the MCP server env to enable.",
        );
      }
      if (args.confirm !== true) {
        throw new Error("Redrive refused: confirm must be true after an explicit UI confirmation.");
      }
      if (fixtureModeEnabled()) {
        throw new Error("Redrive is not available in fixture mode.");
      }
      invalidateExecutionCache(args.executionArn);
      const client = createSfnClient();
      const result = await redriveExecution(client, args.executionArn);
      return {
        content: [
          {
            type: "text",
            text: `Redrive started for ${result.executionArn} at ${result.redriveDate}`,
          },
        ],
        structuredContent: {
          ...result,
          capabilities: serverCapabilities(),
        },
      };
    },
  );

  registerAppResource(
    server,
    "sfn-lens console",
    RESOURCE_URI,
    {
      description: "In-chat Step Functions console (graph, executions, definition, redrive)",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => {
      const html = await readUiHtml();
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );

  return server;
}
