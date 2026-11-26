import type { App as McpApp, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import {
  useApp,
  useDocumentTheme,
  useHostStyles,
} from "@modelcontextprotocol/ext-apps/react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DefinitionPanel } from "./DefinitionPanel";
import { DetailPanel } from "./DetailPanel";
import { ExecutionsPanel } from "./ExecutionsPanel";
import { RedriveDialog } from "./RedriveDialog";
import { StateNode, type StateNodeData } from "./StateNode";
import type {
  ConsoleTab,
  DefinitionPayload,
  ExecutionListItem,
  ExecutionsPayload,
  ShowExecutionPayload,
  StateDetail,
} from "./types";

const nodeTypes = { state: StateNode };

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function isFixtureArn(arn: string | undefined): boolean {
  return Boolean(arn?.includes(":000000000000:") || arn?.startsWith("fixture"));
}

export function App() {
  const [payload, setPayload] = useState<ShowExecutionPayload | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<StateDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [tab, setTab] = useState<ConsoleTab>("graph");

  const [executions, setExecutions] = useState<ExecutionListItem[]>([]);
  const [execStateMachineArn, setExecStateMachineArn] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState("");
  const [nameContains, setNameContains] = useState("");
  const [loadingExecutions, setLoadingExecutions] = useState(false);

  const [definitionText, setDefinitionText] = useState<string | undefined>();
  const [definitionMeta, setDefinitionMeta] = useState<Partial<DefinitionPayload>>({});
  const [loadingDefinition, setLoadingDefinition] = useState(false);

  const [redriveOpen, setRedriveOpen] = useState(false);
  const [redriveBusy, setRedriveBusy] = useState(false);
  const [redriveError, setRedriveError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [fillHost, setFillHost] = useState(false);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);

  const { app, error } = useApp({
    appInfo: { name: "sfn-lens", version: "0.1.0" },
    capabilities: {},
    autoResize: true,
    onAppCreated: (created) => {
      created.ontoolresult = async (result) => {
        const data = result.structuredContent as Record<string, unknown> | undefined;
        if (!data) return;

        // list_executions / get_definition are data-only (no UI). Host may still
        // push their results here when the app called them — update panels only.
        if (data.view === "executions" || (Array.isArray(data.executions) && !data.graph)) {
          const list = data as unknown as ExecutionsPayload;
          setExecutions(list.executions ?? []);
          setExecStateMachineArn(list.stateMachineArn);
          if (list.filters?.statusFilter != null) setStatusFilter(list.filters.statusFilter);
          if (list.filters?.nameContains != null) setNameContains(list.filters.nameContains);
          return;
        }

        if (data.view === "definition" && typeof data.definitionText === "string" && !data.graph) {
          const def = data as unknown as DefinitionPayload;
          setDefinitionText(def.definitionText);
          setDefinitionMeta(def);
          return;
        }

        if (data.comparison && data.right) {
          const right = data.right as ShowExecutionPayload;
          applyExecution(right);
          return;
        }

        if (data.graph && data.overlay) {
          applyExecution(data as unknown as ShowExecutionPayload);
        }
      };
      created.onhostcontextchanged = (ctx) => {
        setHostContext((prev) => ({ ...prev, ...ctx }));
      };
      created.onerror = console.error;
    },
  });

  function applyExecution(next: ShowExecutionPayload, opts?: { clearBanner?: boolean; switchToGraph?: boolean }) {
    setPayload(next);
    const terminalFail =
      next.status === "FAILED" || next.status === "TIMED_OUT" || next.status === "ABORTED";
    setSelected(
      terminalFail ? (next.failedState ?? next.overlay.failedState) : next.failedState,
    );
    setDetail(null);
    setExecStateMachineArn(next.stateMachineArn);
    if (next.definitionText) {
      setDefinitionText(next.definitionText);
      setDefinitionMeta({
        stateMachineArn: next.stateMachineArn,
        name: next.stateMachineArn.split(":").pop(),
        definitionText: next.definitionText,
      });
    }
    if (opts?.switchToGraph !== false) setTab("graph");
    if (opts?.clearBanner) setBanner(null);
  }

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  useHostStyles(app, hostContext);
  const theme = useDocumentTheme();

  // Side/fullscreen pane: fill the iframe. Inline chat: keep a compact workspace
  // so host auto-resize does not leave a giant empty chin.
  useEffect(() => {
    const update = () => {
      const mode = hostContext?.displayMode;
      const tall = typeof window !== "undefined" && window.innerHeight >= 560;
      const next = mode === "fullscreen" || mode === "pip" || tall;
      setFillHost(next);
      document.documentElement.classList.toggle("fill-host", next);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      document.documentElement.classList.remove("fill-host");
    };
  }, [hostContext?.displayMode]);

  useEffect(() => {
    if (!rf || tab !== "graph") return;
    const id = requestAnimationFrame(() => {
      void rf.fitView({ padding: 0.18 });
    });
    return () => cancelAnimationFrame(id);
  }, [rf, fillHost, tab, payload?.executionArn]);

  const refreshExecutions = useCallback(
    async (
      mcp: McpApp,
      opts?: { stateMachineArn?: string; statusFilter?: string; nameContains?: string },
    ) => {
      const sm =
        opts?.stateMachineArn ?? execStateMachineArn ?? payload?.stateMachineArn;
      if (!sm) return;
      setLoadingExecutions(true);
      try {
        const result = await mcp.callServerTool({
          name: "list_executions",
          arguments: {
            stateMachineArn: sm === "fixture" ? undefined : sm,
            statusFilter: (opts?.statusFilter ?? statusFilter) || undefined,
            nameContains: (opts?.nameContains ?? nameContains) || undefined,
            maxResults: 50,
          },
        });
        const data = result.structuredContent as ExecutionsPayload | undefined;
        if (data?.executions) {
          setExecutions(data.executions);
          setExecStateMachineArn(data.stateMachineArn ?? sm);
        }
      } catch (e) {
        console.error(e);
        setBanner(e instanceof Error ? e.message : "Failed to list executions");
      } finally {
        setLoadingExecutions(false);
      }
    },
    [execStateMachineArn, payload?.stateMachineArn, statusFilter, nameContains],
  );

  const loadDefinition = useCallback(
    async (mcp: McpApp) => {
      const sm = payload?.stateMachineArn ?? execStateMachineArn;
      if (!sm) return;
      if (definitionText && definitionMeta.stateMachineArn === sm) return;
      setLoadingDefinition(true);
      try {
        const result = await mcp.callServerTool({
          name: "get_definition",
          arguments: {
            stateMachineArn: sm === "fixture" ? undefined : sm,
            executionArn: payload?.executionArn?.startsWith("fixture:")
              ? undefined
              : payload?.executionArn,
            fixtureId: payload?.executionArn?.startsWith("fixture:")
              ? payload.name
              : undefined,
          },
        });
        const data = result.structuredContent as DefinitionPayload | undefined;
        if (data?.definitionText) {
          setDefinitionText(data.definitionText);
          setDefinitionMeta(data);
        }
      } catch (e) {
        console.error(e);
        setBanner(e instanceof Error ? e.message : "Failed to load definition");
      } finally {
        setLoadingDefinition(false);
      }
    },
    [
      payload?.stateMachineArn,
      payload?.executionArn,
      payload?.name,
      execStateMachineArn,
      definitionText,
      definitionMeta.stateMachineArn,
    ],
  );

  const openExecution = useCallback(
    async (mcp: McpApp, item: ExecutionListItem) => {
      setBanner(null);
      try {
        const result = await mcp.callServerTool({
          name: "show_execution",
          arguments: item.fixtureId
            ? { fixtureId: item.fixtureId }
            : item.executionArn.startsWith("fixture:")
              ? { fixtureId: item.name }
              : { executionArn: item.executionArn },
        });
        const data = result.structuredContent as ShowExecutionPayload | undefined;
        if (data?.graph) applyExecution(data);
      } catch (e) {
        console.error(e);
        setBanner(e instanceof Error ? e.message : "Failed to open execution");
      }
    },
    [],
  );

  const onSelectState = useCallback(
    async (mcp: McpApp, stateName: string, current: ShowExecutionPayload) => {
      setSelected(stateName);
      setLoadingDetail(true);
      try {
        const result = await mcp.callServerTool({
          name: "get_state_detail",
          arguments: {
            executionArn: current.executionArn.startsWith("fixture:")
              ? undefined
              : current.executionArn,
            fixtureId: current.executionArn.startsWith("fixture:")
              ? current.name
              : isFixtureArn(current.executionArn)
                ? current.name
                : undefined,
            stateName,
          },
        });
        const d = (result.structuredContent ?? null) as StateDetail | null;
        setDetail(d);
        const overlay = current.overlay.states[stateName];
        await mcp.updateModelContext({
          content: [
            {
              type: "text",
              text: [
                `User focused state "${stateName}" in sfn-lens.`,
                `Status: ${d?.status ?? overlay?.status ?? "unknown"}`,
                d?.error || overlay?.error ? `Error: ${d?.error ?? overlay?.error}` : null,
                d?.cause || overlay?.cause ? `Cause: ${d?.cause ?? overlay?.cause}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          structuredContent: {
            focusedState: stateName,
            status: d?.status ?? overlay?.status,
            error: d?.error ?? overlay?.error,
            cause: d?.cause ?? overlay?.cause,
          },
        });
      } catch (e) {
        console.error(e);
        setDetail(null);
      } finally {
        setLoadingDetail(false);
      }
    },
    [],
  );

  const reloadExecution = useCallback(
    async (mcp: McpApp, executionArn: string) => {
      const refreshed = await mcp.callServerTool({
        name: "show_execution",
        arguments: executionArn.startsWith("fixture:")
          ? { fixtureId: executionArn.replace(/^fixture:/, "") }
          : { executionArn },
      });
      const data = refreshed.structuredContent as ShowExecutionPayload | undefined;
      if (data?.graph) applyExecution(data, { switchToGraph: false, clearBanner: false });
      return data;
    },
    [],
  );

  const confirmRedrive = useCallback(
    async (mcp: McpApp, current: ShowExecutionPayload) => {
      setRedriveBusy(true);
      setRedriveError(null);
      const priorCount = current.redriveCount ?? 0;
      try {
        await mcp.callServerTool({
          name: "redrive_execution",
          arguments: { executionArn: current.executionArn, confirm: true },
        });
        setRedriveOpen(false);
        setBanner("Redrive accepted. Waiting for status update…");

        // Same ARN is reused; poll briefly — short failures can finish before first refresh.
        let data: ShowExecutionPayload | undefined;
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, i === 0 ? 400 : 700));
          data = await reloadExecution(mcp, current.executionArn);
          if (!data) continue;
          const count = data.redriveCount ?? 0;
          if (data.status === "RUNNING" || count > priorCount) break;
        }

        if (data?.status === "FAILED" || data?.status === "TIMED_OUT" || data?.status === "ABORTED") {
          setBanner(
            `Redrive ran (count ${data.redriveCount ?? "?"}) but the execution is ${data.status} again — same input/path often fails the same way (e.g. Reject).`,
          );
        } else if (data?.status === "RUNNING") {
          setBanner("Redrive in progress — auto-refreshing while RUNNING.");
        } else if (data?.status === "SUCCEEDED") {
          setBanner("Redrive finished successfully.");
        }

        await refreshExecutions(mcp, { stateMachineArn: current.stateMachineArn });
      } catch (e) {
        setRedriveError(e instanceof Error ? e.message : "Redrive failed");
      } finally {
        setRedriveBusy(false);
      }
    },
    [refreshExecutions, reloadExecution],
  );

  // Auto-refresh while the open execution is RUNNING.
  useEffect(() => {
    if (!app || !payload?.executionArn) return;
    if (payload.status !== "RUNNING") return;
    if (isFixtureArn(payload.executionArn)) return;

    const tick = () => {
      void reloadExecution(app, payload.executionArn).then((data) => {
        if (data && data.status !== "RUNNING") {
          setBanner(`Execution finished: ${data.status}`);
          void refreshExecutions(app, { stateMachineArn: data.stateMachineArn });
        }
      });
    };

    const id = window.setInterval(tick, 2500);
    return () => window.clearInterval(id);
  }, [
    app,
    payload?.executionArn,
    payload?.status,
    reloadExecution,
    refreshExecutions,
  ]);

  const palette = useMemo(() => {
    void theme;
    return {
      idle: cssVar("--edge-idle", "#687078"),
      ok: cssVar("--edge-ok", "#037f0c"),
      fail: cssVar("--edge-fail", "#d91515"),
      muted: cssVar("--muted", "#545b64"),
      canvas: cssVar("--canvas", "#f0f2f5"),
      dots: cssVar("--dot-grid", "#c5cbd3"),
    };
  }, [theme]);

  const { nodes, edges } = useMemo(() => {
    if (!payload) return { nodes: [] as Node[], edges: [] as Edge[] };
    const pathSet = new Set(payload.path);

    const nodes: Node<StateNodeData>[] = payload.graph.nodes.map((n) => {
      const ov = payload.overlay.states[n.name];
      return {
        id: n.id,
        type: "state",
        position: { x: n.x, y: n.y },
        data: {
          name: n.name,
          type: n.type,
          status: ov?.status ?? "NOT_RUN",
          durationMs: ov?.durationMs,
          error: ov?.error,
          isFailedPath: pathSet.has(n.name) && payload.status === "FAILED",
        },
        selected: selected === n.name,
      };
    });

    const edges: Edge[] = payload.graph.edges.map((e) => {
      const sourceNode = payload.graph.nodes.find((n) => n.id === e.source);
      const targetNode = payload.graph.nodes.find((n) => n.id === e.target);
      const sourceRan = sourceNode ? pathSet.has(sourceNode.name) : false;
      const targetRan = targetNode ? pathSet.has(targetNode.name) : false;
      const onTakenPath = sourceRan && targetRan;
      const onFailPath = onTakenPath && payload.status === "FAILED";
      const notTaken = !onTakenPath;

      let stroke = palette.idle;
      let strokeWidth = 1.5;
      if (onFailPath) {
        stroke = palette.fail;
        strokeWidth = 2.5;
      } else if (onTakenPath) {
        stroke = palette.ok;
        strokeWidth = 2.25;
      }

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label:
          e.kind === "choice" || e.kind === "default" || e.kind === "catch" ? e.label : undefined,
        type: "smoothstep",
        animated: onFailPath,
        style: {
          stroke,
          strokeWidth,
          opacity: notTaken ? 0.35 : 1,
          strokeDasharray: e.kind === "catch" ? "6 4" : undefined,
        },
        labelStyle: { fill: palette.muted, fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: palette.canvas, fillOpacity: 0.92 },
        labelBgPadding: [3, 1] as [number, number],
        labelBgBorderRadius: 3,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: stroke,
        },
      };
    });

    return { nodes, edges };
  }, [payload, selected, palette]);

  if (error) {
    return <div className="connecting">Error: {error.message}</div>;
  }
  if (!app) {
    return <div className="connecting">Connecting to host…</div>;
  }

  const fixture = payload ? isFixtureArn(payload.executionArn) : false;
  const showRedrive =
    Boolean(payload?.capabilities?.redriveEnabled) &&
    Boolean(payload?.redrivable) &&
    !fixture;

  return (
    <div className={fillHost ? "app fill-host" : "app"}>
      <header className="header">
        <h1>sfn-lens</h1>
        {payload ? (
          <>
            <span className={`badge ${payload.status}`}>{payload.status}</span>
            <span className="meta">{payload.name}</span>
            {fixture ? <span className="fixture-tag">fixture (not in AWS)</span> : null}
            {payload.failedState &&
            (payload.status === "FAILED" ||
              payload.status === "TIMED_OUT" ||
              payload.status === "ABORTED") ? (
              <span className="meta">failed @ {payload.failedState}</span>
            ) : null}
            {payload.durationMs != null ? (
              <span className="meta">{payload.durationMs} ms</span>
            ) : null}
            {(payload.redriveCount ?? 0) > 0 ? (
              <span className="meta">redriven ×{payload.redriveCount}</span>
            ) : null}
          </>
        ) : (
          <span className="meta">Open an execution or browse the list</span>
        )}
        <div className="header-actions">
          {payload && !fixture ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setBanner(null);
                void reloadExecution(app, payload.executionArn);
              }}
            >
              Refresh
            </button>
          ) : null}
          {showRedrive ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setRedriveError(null);
                setRedriveOpen(true);
              }}
            >
              Redrive
            </button>
          ) : null}
        </div>
      </header>

      <nav className="tabs" aria-label="Console views">
        <button
          type="button"
          className={tab === "graph" ? "tab active" : "tab"}
          onClick={() => setTab("graph")}
          disabled={!payload}
        >
          Graph
        </button>
        <button
          type="button"
          className={tab === "executions" ? "tab active" : "tab"}
          onClick={() => {
            setTab("executions");
            void refreshExecutions(app);
          }}
        >
          Executions
        </button>
        <button
          type="button"
          className={tab === "definition" ? "tab active" : "tab"}
          onClick={() => {
            setTab("definition");
            void loadDefinition(app);
          }}
        >
          Definition
        </button>
      </nav>

      {banner ? <div className="banner">{banner}</div> : null}

      {tab === "graph" ? (
        <div className="body">
          <div className="graph-pane">
            {payload ? (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.18 }}
                minZoom={0.35}
                maxZoom={1.5}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                colorMode={theme === "dark" ? "dark" : "light"}
                onInit={setRf}
                onNodeClick={(_, node) => {
                  const name = (node.data as StateNodeData).name;
                  void onSelectState(app, name, payload);
                }}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "smoothstep" }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={18}
                  size={1.2}
                  color={palette.dots}
                />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <div className="empty">No execution loaded. Use the Executions tab or ask the model to show one.</div>
            )}
          </div>
          <DetailPanel
            stateName={selected}
            overlay={selected ? payload?.overlay.states[selected] : undefined}
            detail={detail}
            loading={loadingDetail}
            executionError={payload?.error}
            executionCause={payload?.cause}
          />
        </div>
      ) : null}

      {tab === "executions" ? (
        <ExecutionsPanel
          stateMachineArn={execStateMachineArn ?? payload?.stateMachineArn}
          executions={executions}
          statusFilter={statusFilter}
          nameContains={nameContains}
          loading={loadingExecutions}
          activeArn={payload?.executionArn}
          onStatusFilter={(v) => {
            setStatusFilter(v);
            void refreshExecutions(app, { statusFilter: v });
          }}
          onNameContains={(v) => {
            setNameContains(v);
            void refreshExecutions(app, { nameContains: v });
          }}
          onRefresh={() => void refreshExecutions(app)}
          onOpen={(item) => void openExecution(app, item)}
        />
      ) : null}

      {tab === "definition" ? (
        <DefinitionPanel
          name={definitionMeta.name}
          stateMachineArn={definitionMeta.stateMachineArn ?? payload?.stateMachineArn}
          type={definitionMeta.type}
          status={definitionMeta.status}
          roleArn={definitionMeta.roleArn}
          definitionText={definitionText}
          loading={loadingDefinition}
        />
      ) : null}

      {redriveOpen && payload ? (
        <RedriveDialog
          executionName={payload.name}
          executionArn={payload.executionArn}
          busy={redriveBusy}
          error={redriveError}
          onCancel={() => setRedriveOpen(false)}
          onConfirm={() => void confirmRedrive(app, payload)}
        />
      ) : null}
    </div>
  );
}
