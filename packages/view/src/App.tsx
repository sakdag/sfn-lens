import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useState } from "react";
import { DetailPanel } from "./DetailPanel";
import { StateNode, type StateNodeData } from "./StateNode";
import type { ShowExecutionPayload, StateDetail } from "./types";

const nodeTypes = { state: StateNode };

function asPayload(data: unknown): ShowExecutionPayload | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (obj.comparison && obj.right) {
    // compare_executions — show the right (usually failed) run
    return obj.right as ShowExecutionPayload;
  }
  if (obj.graph && obj.overlay) return obj as unknown as ShowExecutionPayload;
  return null;
}

export function App() {
  const [payload, setPayload] = useState<ShowExecutionPayload | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<StateDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

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
      created.onerror = console.error;
    },
  });

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

  const { nodes, edges } = useMemo(() => {
    if (!payload) return { nodes: [] as Node[], edges: [] as Edge[] };
    const failedPath = new Set(payload.path);
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
          isFailedPath: failedPath.has(n.name) && payload.status === "FAILED",
        },
        selected: selected === n.name,
      };
    });

    const edges: Edge[] = payload.graph.edges.map((e) => {
      const targetNode = payload.graph.nodes.find((n) => n.id === e.target);
      const onFailPath =
        payload.status === "FAILED" &&
        targetNode &&
        failedPath.has(targetNode.name) &&
        payload.graph.nodes.some((n) => n.id === e.source && failedPath.has(n.name));
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        style: onFailPath ? { stroke: "#f07178", strokeWidth: 2.5 } : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      };
    });

    return { nodes, edges };
  }, [payload, selected]);

  if (error) {
    return <div className="connecting">Error: {error.message}</div>;
  }
  if (!app) {
    return <div className="connecting">Connecting to host…</div>;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>sfn-lens</h1>
        {payload ? (
          <>
            <span className={`badge ${payload.status}`}>{payload.status}</span>
            <span className="meta">{payload.name}</span>
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
              onNodeClick={(_, node) => {
                const name = (node.data as StateNodeData).name;
                void onSelectState(app, name, payload);
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} size={1} />
              <Controls />
              <MiniMap pannable zoomable />
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
