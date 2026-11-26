import type { GraphEdge, GraphNode, WorkflowGraph } from "./types.js";

export interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutGraph {
  nodes: LaidOutNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

const NODE_W = 180;
const NODE_H = 56;
const GAP_X = 48;
const GAP_Y = 72;

/**
 * Deterministic layered layout (no native deps). Top-level states in BFS layers;
 * nested Parallel/Map children offset under their parent.
 */
export function layoutGraph(graph: WorkflowGraph): LaidOutGraph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const topLevel = graph.nodes.filter((n) => !n.parentId);
  const childrenOf = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }

  const startId = graph.startAt;
  const layers = buildLayers(startId, topLevel, graph.edges);
  const positions = new Map<string, { x: number; y: number }>();

  let maxX = 0;
  layers.forEach((layer, depth) => {
    layer.forEach((id, i) => {
      const x = i * (NODE_W + GAP_X);
      const y = depth * (NODE_H + GAP_Y);
      positions.set(id, { x, y });
      maxX = Math.max(maxX, x + NODE_W);
    });
  });

  // Place nested nodes under parents
  for (const [parentId, kids] of childrenOf) {
    const parentPos = positions.get(parentId) ?? { x: 0, y: 0 };
    kids.forEach((kid, i) => {
      if (positions.has(kid.id)) return;
      positions.set(kid.id, {
        x: parentPos.x + (i % 3) * (NODE_W + 24),
        y: parentPos.y + NODE_H + 28 + Math.floor(i / 3) * (NODE_H + 24),
      });
    });
  }

  // Orphans
  for (const n of graph.nodes) {
    if (!positions.has(n.id)) {
      positions.set(n.id, { x: maxX + GAP_X, y: 0 });
      maxX += NODE_W + GAP_X;
    }
  }

  const laid: LaidOutNode[] = graph.nodes.map((n) => {
    const p = positions.get(n.id)!;
    return { ...n, x: p.x, y: p.y, width: NODE_W, height: NODE_H };
  });

  const height = Math.max(...laid.map((n) => n.y + n.height), NODE_H) + 40;
  const width = Math.max(...laid.map((n) => n.x + n.width), NODE_W) + 40;

  void byId;
  return { nodes: laid, edges: graph.edges, width, height };
}

function buildLayers(
  startAt: string,
  topLevel: GraphNode[],
  edges: GraphEdge[],
): string[][] {
  const topIds = new Set(topLevel.map((n) => n.id));
  const start = topLevel.find((n) => n.name === startAt)?.id ?? startAt;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!topIds.has(e.source) || !topIds.has(e.target)) continue;
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }

  const layers: string[][] = [];
  const seen = new Set<string>();
  let current = [start];
  while (current.length) {
    const layer = current.filter((id) => !seen.has(id));
    for (const id of layer) seen.add(id);
    if (layer.length) layers.push(layer);
    const next: string[] = [];
    for (const id of layer) {
      for (const t of adj.get(id) ?? []) {
        if (!seen.has(t)) next.push(t);
      }
    }
    current = [...new Set(next)];
  }

  for (const n of topLevel) {
    if (!seen.has(n.id)) {
      layers.push([n.id]);
      seen.add(n.id);
    }
  }
  return layers;
}
