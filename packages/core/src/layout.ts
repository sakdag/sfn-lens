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

const NODE_W = 200;
const NODE_H = 64;
const GAP_X = 72;
const GAP_Y = 96;

/**
 * Deterministic layered layout (console-like top→bottom flow).
 * Each layer is centered horizontally so Choice branches fan out symmetrically.
 */
export function layoutGraph(graph: WorkflowGraph): LaidOutGraph {
  const topLevel = graph.nodes.filter((n) => !n.parentId);
  const childrenOf = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }

  const layers = buildLayers(graph.startAt, topLevel, graph.edges);
  const positions = new Map<string, { x: number; y: number }>();

  const maxLayerWidth = Math.max(
    ...layers.map((layer) => layer.length * NODE_W + Math.max(0, layer.length - 1) * GAP_X),
    NODE_W,
  );

  layers.forEach((layer, depth) => {
    const layerWidth = layer.length * NODE_W + Math.max(0, layer.length - 1) * GAP_X;
    const originX = (maxLayerWidth - layerWidth) / 2;
    layer.forEach((id, i) => {
      positions.set(id, {
        x: originX + i * (NODE_W + GAP_X),
        y: 24 + depth * (NODE_H + GAP_Y),
      });
    });
  });

  for (const [parentId, kids] of childrenOf) {
    const parentPos = positions.get(parentId) ?? { x: 0, y: 0 };
    const kidWidth = kids.length * (NODE_W * 0.85) + Math.max(0, kids.length - 1) * 36;
    const originX = parentPos.x + NODE_W / 2 - kidWidth / 2;
    kids.forEach((kid, i) => {
      if (positions.has(kid.id)) return;
      positions.set(kid.id, {
        x: originX + i * (NODE_W * 0.85 + 36),
        y: parentPos.y + NODE_H + 40,
      });
    });
  }

  let maxX = maxLayerWidth;
  for (const n of graph.nodes) {
    if (!positions.has(n.id)) {
      positions.set(n.id, { x: maxX + GAP_X, y: 24 });
      maxX += NODE_W + GAP_X;
    }
  }

  const laid: LaidOutNode[] = graph.nodes.map((n) => {
    const p = positions.get(n.id)!;
    return { ...n, x: p.x, y: p.y, width: NODE_W, height: NODE_H };
  });

  const height = Math.max(...laid.map((n) => n.y + n.height), NODE_H) + 48;
  const width = Math.max(...laid.map((n) => n.x + n.width), NODE_W) + 48;

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
    // Prefer next/choice/default order: next first, then choice, default, catch last
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }

  // Stable unique adjacency preserving edge order from ASL walk
  for (const [k, list] of adj) {
    adj.set(k, [...new Set(list)]);
  }

  const layers: string[][] = [];
  const depthOf = new Map<string, number>();
  const queue = [start];
  depthOf.set(start, 0);

  while (queue.length) {
    const id = queue.shift()!;
    const depth = depthOf.get(id) ?? 0;
    if (!layers[depth]) layers[depth] = [];
    if (!layers[depth]!.includes(id)) layers[depth]!.push(id);

    for (const t of adj.get(id) ?? []) {
      const nextDepth = depth + 1;
      const prev = depthOf.get(t);
      if (prev == null || nextDepth < prev) {
        depthOf.set(t, nextDepth);
        queue.push(t);
      }
    }
  }

  for (const n of topLevel) {
    if (!depthOf.has(n.id)) {
      const d = layers.length;
      depthOf.set(n.id, d);
      layers.push([n.id]);
    }
  }

  return layers.filter((l) => l.length > 0);
}
