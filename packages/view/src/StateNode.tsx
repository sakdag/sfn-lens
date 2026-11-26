import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StateRunStatus } from "./types";

export type StateNodeData = {
  name: string;
  type: string;
  status: StateRunStatus;
  durationMs?: number;
  error?: string;
  isFailedPath?: boolean;
};

export function StateNode({ data, selected }: NodeProps & { data: StateNodeData }) {
  const dur =
    data.durationMs != null
      ? data.durationMs >= 1000
        ? `${(data.durationMs / 1000).toFixed(1)}s`
        : `${data.durationMs}ms`
      : null;

  return (
    <div className={`state-node status-${data.status}${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="name">{data.name}</div>
      <div className="sub">
        {data.type}
        {dur ? ` · ${dur}` : ""}
        {data.status !== "NOT_RUN" && data.status !== "SUCCEEDED" ? ` · ${data.status}` : ""}
      </div>
      {data.error ? <div className="sub" style={{ color: "var(--fail)" }}>{data.error}</div> : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
