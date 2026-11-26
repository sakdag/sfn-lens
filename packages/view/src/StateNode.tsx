import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { StateRunStatus } from "./types";

export type StateNodeData = {
  name: string;
  type: string;
  status: StateRunStatus;
  durationMs?: number;
  error?: string;
  isFailedPath?: boolean;
};

type StateFlowNode = Node<StateNodeData, "state">;

function TypeIcon({ type }: { type: string }) {
  switch (type) {
    case "Choice":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3v6M12 15v6M12 9l-7 4M12 9l7 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Parallel":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
        </svg>
      );
    case "Map":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
        </svg>
      );
    case "Succeed":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="8" />
          <path d="M8.5 12.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Fail":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="8" />
          <path d="M9 9l6 6M15 9l-6 6" strokeLinecap="round" />
        </svg>
      );
    case "Wait":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Pass":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path
            d="M8 4h8l2 4v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8l2-4z"
            strokeLinejoin="round"
          />
          <path d="M8 8h8" strokeLinecap="round" />
        </svg>
      );
  }
}

function formatDuration(ms?: number): string | null {
  if (ms == null) return null;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function StateNode({ data, selected }: NodeProps<StateFlowNode>) {
  const dur = formatDuration(data.durationMs);

  return (
    <div className={`state-node status-${data.status}${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Top} className="state-handle" />
      <div className="state-node-inner">
        <div className="icon" aria-hidden>
          <TypeIcon type={data.type} />
        </div>
        <div className="body-text">
          <div className="name">{data.name}</div>
          <div className="sub">
            <span className="status-dot" />
            <span>{data.type}</span>
            {dur ? <span>· {dur}</span> : null}
          </div>
          {data.error ? <div className="error-line">{data.error}</div> : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="state-handle" />
    </div>
  );
}
