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
  overlayFromHistory,
  redactJsonString,
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
  extractStateIo,
  listRecentExecutions,
  loadLiveExecution,
  resolveExecutionArn,
} from "./aws.js";
import {
  findFixtureByArnOrName,
  fixtureModeEnabled,
  listFixtures,
  loadFixture,
} from "./fixture.js";

const RESOURCE_URI = "ui://sfn-lens/execution.html";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

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

async function loadExecutionData(input: {
  executionArn?: string;
  stateMachineArn?: string;
  name?: string;
  fixtureId?: string;
}): Promise<{
  view: ExecutionViewModel;
  history: import("@sfn-lens/core").HistoryEvent[];
  stateDetails?: Record<string, { input?: unknown; output?: unknown; error?: string; cause?: string }>;
}> {
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
    return { view, history: fix.history, stateDetails: fix.stateDetails };
  }

  const client = createSfnClient();
  const arn = await resolveExecutionArn(client, input);
  const live = await loadLiveExecution(client, arn);
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
  });
  return { view, history: live.history };
}

function toolText(summary: ExecutionViewModel["summary"]): string {
  const lines = [
    `Execution ${summary.name} — ${summary.status}`,
    summary.failedState ? `Failed state: ${summary.failedState}` : null,
    summary.error ? `Error: ${summary.error}` : null,
    summary.cause ? `Cause: ${summary.cause}` : null,
    `Path: ${summary.path.join(" → ") || "(none)"}`,
    `Duration: ${summary.durationMs ?? "?"} ms`,
    summary.uiHint,
  ];
  return lines.filter(Boolean).join("\n");
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
        "Load an AWS Step Functions execution and render an interactive graph in the chat. Prefer this over dumping raw GetExecutionHistory. Pass executionArn, or stateMachineArn+name, or fixtureId when SFN_LENS_MODE=fixture.",
      inputSchema: z.object({
        executionArn: z.string().optional().describe("Full execution ARN"),
        stateMachineArn: z.string().optional().describe("State machine ARN (with name)"),
        name: z.string().optional().describe("Execution name"),
        fixtureId: z.string().optional().describe("Fixture id when using fixture mode"),
      }),
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async (args) => {
      const { view } = await loadExecutionData(args);
      const laidOut = layoutGraph(view.graph);
      const structuredContent = {
        ...view.summary,
        graph: laidOut,
        overlay: view.overlay,
      };
      return {
        content: [{ type: "text", text: toolText(view.summary) }],
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
        "Compare two executions: path differences, duration deltas, and the first diverging state. Renders a comparison view in the chat.",
      inputSchema: z.object({
        leftExecutionArn: z.string().describe("Baseline execution ARN (e.g. last success)"),
        rightExecutionArn: z.string().describe("Execution ARN to compare (e.g. failed run)"),
        leftFixtureId: z.string().optional(),
        rightFixtureId: z.string().optional(),
      }),
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
      const structuredContent = {
        comparison,
        left: { summary: left.view.summary, graph: layoutGraph(left.view.graph), overlay: left.view.overlay },
        right: {
          summary: right.view.summary,
          graph: layoutGraph(right.view.graph),
          overlay: right.view.overlay,
        },
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
      _meta: {
        ui: { visibility: ["model"] },
      },
    },
    async (args) => {
      if (fixtureModeEnabled()) {
        const fixtures = await listFixtures();
        const machines = [
          {
            name: "fixtures",
            stateMachineArn: "fixture",
            status: "ACTIVE",
          },
        ];
        return {
          content: [{ type: "text", text: JSON.stringify({ machines, fixtures }, null, 2) }],
          structuredContent: { mode: "fixture", machines, fixtures },
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
        structuredContent: { mode: "live", machines },
      };
    },
  );

  registerAppTool(
    server,
    "list_executions",
    {
      title: "List Step Functions executions",
      description:
        "List recent executions for a state machine (or fixtures in fixture mode). Prefer list_state_machines first if the ARN is unknown. Pass stateMachineArn in live mode.",
      inputSchema: z.object({
        stateMachineArn: z
          .string()
          .optional()
          .describe("State machine ARN (required in live mode)"),
        statusFilter: z
          .enum(["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"])
          .optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      _meta: {
        ui: { visibility: ["model"] },
      },
    },
    async (args) => {
      if (fixtureModeEnabled()) {
        const fixtures = await listFixtures();
        return {
          content: [{ type: "text", text: JSON.stringify(fixtures, null, 2) }],
          structuredContent: { mode: "fixture", executions: fixtures },
        };
      }
      if (!args.stateMachineArn) {
        throw new Error("stateMachineArn is required in live mode; call list_state_machines first");
      }
      const client = createSfnClient();
      const executions = await listRecentExecutions(client, args);
      return {
        content: [{ type: "text", text: JSON.stringify(executions, null, 2) }],
        structuredContent: { mode: "live", executions },
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

      const detail: StateDetail = {
        name: args.stateName,
        type: node?.type,
        status: overlay?.status ?? "NOT_RUN",
        enteredAt: overlay?.enteredAt,
        exitedAt: overlay?.exitedAt,
        durationMs: overlay?.durationMs,
        error: overlay?.error ?? fromFixture?.error ?? fromHistory.error,
        cause: overlay?.cause ?? fromFixture?.cause ?? fromHistory.cause,
        retryCount: overlay?.retryCount ?? 0,
        caught: overlay?.caught ?? false,
        input: redactValue(fromFixture?.input ?? fromHistory.input),
        output: redactValue(fromFixture?.output ?? fromHistory.output),
        retries: fromHistory.retries.map((r) => ({
          ...r,
          cause: r.cause ? String(redactValue({ cause: r.cause })).slice(0, 200) : undefined,
        })),
      };

      // Also redact execution-level input if someone stored strings
      void redactJsonString;
      void overlayFromHistory;

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
      description: "Paginated history events for UI drill-down. App-only. Not for the model.",
      inputSchema: z.object({
        executionArn: z.string().optional(),
        fixtureId: z.string().optional(),
        name: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async (args) => {
      const { history } = await loadExecutionData(args);
      const slice = history.slice(args.offset, args.offset + args.limit).map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: e.timestamp,
        // Strip large payloads from list page
      }));
      return {
        content: [{ type: "text", text: `events ${args.offset}-${args.offset + slice.length} of ${history.length}` }],
        structuredContent: {
          total: history.length,
          offset: args.offset,
          limit: args.limit,
          events: slice,
        },
      };
    },
  );

  registerAppResource(
    server,
    "sfn-lens execution view",
    RESOURCE_URI,
    {
      description: "Interactive Step Functions execution graph",
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
