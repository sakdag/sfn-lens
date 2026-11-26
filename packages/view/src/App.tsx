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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DetailPanel } from "./DetailPanel";
import { StateNode, type StateNodeData } from "./StateNode";
import type { ShowExecutionPayload, StateDetail } from "./types";

const nodeTypes = { state: StateNode };

function asPayload(data: unknown): ShowExecutionPayload | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (obj.comparison && obj.right) {
    return obj.right as ShowExecutionPayload;
  }
  if (obj.graph && obj.overlay) return obj as unknown as ShowExecutionPayload;
  return null;
}

function isFixtureArn(arn: string | undefined): boolean {
  return Boolean(arn?.includes(":000000000000:") || arn?.startsWith("fixture"));
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function App() {
  const [payload, setPayload] = useState<ShowExecutionPayload | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<StateDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();

  const { app, error } = useApp({
    appInfo: { name: "sfn-lens", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolresult = async (result) => {
        const next = asPayload(result.structuredContent);
        if (next) {
          setPayload(next);
          setSelected(next.failedState ?? next.overlay.failedState);
          setDetail(null);
        }
      };
      created.onhostcontextchanged = (ctx) => {
        setHostContext((prev) => ({ ...prev, ...ctx }));
      };
      created.onerror = console.error;
    },
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  useHostStyles(app, hostContext);
  const theme = useDocumentTheme();

  const onSelectState = useCallback(
    async (mcp: McpApp, stateName: string, current: ShowExecutionPayload) => {
      setSelected(stateName);
      setLoadingDetail(true);
      try {
        const result = await mcp.callServerTool({
          name: "get_state_detail",
          arguments: {
            executionArn: current.executionArn,
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
                d?.input !== undefined
                  ? `Input (redacted, truncated): ${JSON.stringify(d.input).slice(0, 800)}`
                  : null,
                d?.output !== undefined
                  ? `Output (redacted, truncated): ${JSON.stringify(d.output).slice(0, 800)}`
                  : null,
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

  const palette = useMemo(() => {
    // Re-read when theme flips so edges/background stay in sync.
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
        label: e.kind === "choice" || e.kind === "default" || e.kind === "catch" ? e.label : undefined,
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

  return (
    <div className="app">
      <header className="header">
        <h1>sfn-lens</h1>
        {payload ? (
          <>
            <span className={`badge ${payload.status}`}>{payload.status}</span>
            <span className="meta">{payload.name}</span>
            {fixture ? <span className="fixture-tag">fixture (not in AWS)</span> : null}
            {payload.failedState ? (
              <span className="meta">failed @ {payload.failedState}</span>
            ) : null}
            {payload.durationMs != null ? (
              <span className="meta">{payload.durationMs} ms</span>
            ) : null}
          </>
        ) : (
          <span className="meta">Waiting for show_execution…</span>
        )}
      </header>
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
            <div className="empty">No execution loaded.</div>
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
    </div>
  );
}
