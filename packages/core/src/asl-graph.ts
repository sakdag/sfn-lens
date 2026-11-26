import type {
  AslDefinition,
  AslState,
  GraphEdge,
  GraphNode,
  WorkflowGraph,
} from "./types.js";

/**
 * Convert an ASL definition into a flat graph suitable for React Flow.
 * Nested Parallel branches and Map iterators become child nodes with parentId.
 */
export function aslToGraph(definition: AslDefinition): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  walkStates(definition.States, definition.StartAt, undefined, undefined, nodes, edges, seen);

  const start = nodes.find((n) => n.name === definition.StartAt && !n.parentId);
  if (start) start.isStart = true;

  return { startAt: definition.StartAt, nodes, edges };
}

function nodeId(name: string, parentId?: string, branchIndex?: number): string {
  if (parentId == null) return name;
  if (branchIndex != null) return `${parentId}/b${branchIndex}/${name}`;
  return `${parentId}/${name}`;
}

function walkStates(
  states: Record<string, AslState>,
  startAt: string,
  parentId: string | undefined,
  branchIndex: number | undefined,
  nodes: GraphNode[],
  edges: GraphEdge[],
  seen: Set<string>,
): void {
  const queue = [startAt];
  const visitedLocal = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visitedLocal.has(name)) continue;
    visitedLocal.add(name);

    const state = states[name];
    if (!state) continue;

    const id = nodeId(name, parentId, branchIndex);
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({
        id,
        name,
        type: state.Type,
        parentId,
        branchIndex,
        resource: state.Resource,
        retry: state.Retry,
        catchTargets: state.Catch?.map((c) => c.Next),
        isTerminal: state.Type === "Succeed" || state.Type === "Fail" || state.End === true,
      });
    }

    addTransitions(name, state, id, parentId, branchIndex, states, nodes, edges, seen, queue);
  }
}

function addTransitions(
  name: string,
  state: AslState,
  id: string,
  parentId: string | undefined,
  branchIndex: number | undefined,
  states: Record<string, AslState>,
  nodes: GraphNode[],
  edges: GraphEdge[],
  seen: Set<string>,
  queue: string[],
): void {
  const pushNext = (target: string, kind: GraphEdge["kind"], label?: string) => {
    const tid = nodeId(target, parentId, branchIndex);
    const eid = `${id}->${tid}:${kind}:${label ?? ""}`;
    if (!edges.some((e) => e.id === eid)) {
      edges.push({ id: eid, source: id, target: tid, kind, label });
    }
    queue.push(target);
  };

  if (state.Type === "Choice") {
    for (const [i, rule] of (state.Choices ?? []).entries()) {
      pushNext(rule.Next, "choice", `choice ${i + 1}`);
    }
    if (state.Default) pushNext(state.Default, "default", "default");
  } else if (state.Type === "Parallel" && state.Branches) {
    for (const [bi, branch] of state.Branches.entries()) {
      const branchParent = `${id}#branch${bi}`;
      // Synthetic branch container edge
      edges.push({
        id: `${id}->${branchParent}`,
        source: id,
        target: nodeId(branch.StartAt, id, bi),
        kind: "parallel",
        label: `branch ${bi}`,
      });
      walkStates(branch.States, branch.StartAt, id, bi, nodes, edges, seen);
    }
    if (state.Next) pushNext(state.Next, "next");
  } else if (state.Type === "Map") {
    const iterator = state.ItemProcessor ?? state.Iterator;
    if (iterator) {
      edges.push({
        id: `${id}->map-body`,
        source: id,
        target: nodeId(iterator.StartAt, id, 0),
        kind: "map",
        label: "iterator",
      });
      walkStates(iterator.States, iterator.StartAt, id, 0, nodes, edges, seen);
    }
    if (state.Next) pushNext(state.Next, "next");
  } else if (state.Next) {
    pushNext(state.Next, "next");
  }

  for (const c of state.Catch ?? []) {
    pushNext(c.Next, "catch", c.ErrorEquals.join("|"));
  }

  // Silence unused in Fail/Succeed with no edges
  void states;
  void name;
}
