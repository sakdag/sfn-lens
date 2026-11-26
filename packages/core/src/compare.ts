import type { ExecutionCompareResult, ExecutionOverlay } from "./types.js";

export function compareOverlays(params: {
  leftArn: string;
  rightArn: string;
  left: ExecutionOverlay;
  right: ExecutionOverlay;
}): ExecutionCompareResult {
  const { left, right } = params;
  const leftSet = new Set(left.path);
  const rightSet = new Set(right.path);
  const onlyLeft = left.path.filter((s) => !rightSet.has(s));
  const onlyRight = right.path.filter((s) => !leftSet.has(s));
  const shared = left.path.filter((s) => rightSet.has(s));

  let firstDivergingState: string | undefined;
  const max = Math.max(left.path.length, right.path.length);
  for (let i = 0; i < max; i++) {
    if (left.path[i] !== right.path[i]) {
      firstDivergingState = left.path[i] ?? right.path[i];
      break;
    }
  }

  const names = new Set([...Object.keys(left.states), ...Object.keys(right.states)]);
  const stateDurationDeltas = [...names]
    .map((name) => {
      const leftMs = left.states[name]?.durationMs;
      const rightMs = right.states[name]?.durationMs;
      const deltaMs =
        leftMs != null && rightMs != null ? rightMs - leftMs : undefined;
      return { name, leftMs, rightMs, deltaMs };
    })
    .filter((d) => d.leftMs != null || d.rightMs != null)
    .sort((a, b) => Math.abs(b.deltaMs ?? 0) - Math.abs(a.deltaMs ?? 0));

  const durationDiffMs =
    left.durationMs != null && right.durationMs != null
      ? right.durationMs - left.durationMs
      : undefined;

  const summaryText = [
    `Compared ${params.leftArn} (${left.status}) vs ${params.rightArn} (${right.status}).`,
    firstDivergingState
      ? `First diverging state: ${firstDivergingState}.`
      : "Paths match through all entered states.",
    durationDiffMs != null ? `Total duration delta (right - left): ${durationDiffMs} ms.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    leftArn: params.leftArn,
    rightArn: params.rightArn,
    leftStatus: left.status,
    rightStatus: right.status,
    firstDivergingState,
    pathDiff: { onlyLeft, onlyRight, shared },
    durationDiffMs,
    stateDurationDeltas,
    summaryText,
  };
}
