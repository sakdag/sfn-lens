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
const NEST_INDENT = 40;
const NEST_GAP = 28;

/**
 * Deterministic layered layout (console-like top→bottom flow).
 * Map/Parallel children sit under their parent; later top-level rows shift down
 * so nested nodes never land on a sibling in the same layer (e.g. MapItem on PickProcess).
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

  // Nest children under parents (top → bottom), shifting everything below each nest.
  const parents = [...childrenOf.keys()].sort((a, b) => {
    const ya = positions.get(a)?.y ?? 0;
    const yb = positions.get(b)?.y ?? 0;
    return ya - yb;
  });

  for (const parentId of parents) {
    const kids = childrenOf.get(parentId) ?? [];
    const parentPos = positions.get(parentId);
    if (!parentPos || kids.length === 0) continue;

    const nestH = kids.length * (NODE_H + NEST_GAP) + 16;
    const kidIds = new Set(kids.map((k) => k.id));

    kids.forEach((kid, i) => {
      positions.set(kid.id, {
        x: parentPos.x + NEST_INDENT,
        y: parentPos.y + NODE_H + NEST_GAP + i * (NODE_H + NEST_GAP),
      });
    });

    // Push every other node that sits below the parent so nested rows have room.
    for (const [id, pos] of positions) {
      if (id === parentId || kidIds.has(id)) continue;
      if (pos.y > parentPos.y) {
        positions.set(id, { x: pos.x, y: pos.y + nestH });
      }
    }
  }

  // Resolve any remaining AABB overlaps (defensive).
  resolveOverlaps(positions, graph.nodes);

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

function resolveOverlaps(
  positions: Map<string, { x: number; y: number }>,
  nodes: GraphNode[],
): void {
  const ids = nodes.map((n) => n.id);
  let moved = true;
  let guard = 0;
  while (moved && guard++ < 40) {
    moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        const pa = positions.get(a)!;
        const pb = positions.get(b)!;
        const overlapX = pa.x < pb.x + NODE_W && pa.x + NODE_W > pb.x;
        const overlapY = pa.y < pb.y + NODE_H && pa.y + NODE_H > pb.y;
        if (!overlapX || !overlapY) continue;
        // Push the lower (or rightmost if tied) node down.
        if (pb.y >= pa.y) {
          positions.set(b, { x: pb.x, y: pa.y + NODE_H + NEST_GAP });
        } else {
          positions.set(a, { x: pa.x, y: pb.y + NODE_H + NEST_GAP });
        }
        moved = true;
      }
    }
  }
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
