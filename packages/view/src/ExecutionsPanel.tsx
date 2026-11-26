import { useState } from "react";
import type { ExecutionListItem } from "./types";

const STATUSES = ["", "RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"] as const;

export function ExecutionsPanel(props: {
  stateMachineArn?: string;
  executions: ExecutionListItem[];
  statusFilter: string;
  nameContains: string;
  loading?: boolean;
  activeArn?: string;
  onStatusFilter: (v: string) => void;
  onNameContains: (v: string) => void;
  onRefresh: () => void;
  onOpen: (item: ExecutionListItem) => void;
}) {
  const {
    stateMachineArn,
    executions,
    statusFilter,
    nameContains,
    loading,
    activeArn,
    onStatusFilter,
    onNameContains,
    onRefresh,
    onOpen,
  } = props;
  const [draftName, setDraftName] = useState(nameContains);

  return (
    <div className="console-panel">
      <div className="filters">
        <label className="filter">
          <span>Status</span>
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilter(e.target.value)}
            disabled={loading}
          >
            <option value="">All</option>
            {STATUSES.filter(Boolean).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="filter filter-grow">
          <span>Name contains</span>
          <input
            value={draftName}
            placeholder="e.g. f6-"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onNameContains(draftName);
            }}
            disabled={loading}
          />
        </label>
        <button type="button" className="btn" onClick={() => onNameContains(draftName)} disabled={loading}>
          Apply
        </button>
        <button type="button" className="btn btn-ghost" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="meta filters-meta">
        {stateMachineArn ? stateMachineArn : "No state machine selected"}
        {loading ? " · loading…" : ` · ${executions.length} shown`}
      </div>

      <div className="table-wrap">
        <table className="exec-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Started</th>
              <th>Stopped</th>
            </tr>
          </thead>
          <tbody>
            {executions.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="empty-row">
                  No executions match these filters.
                </td>
              </tr>
            ) : (
              executions.map((e) => (
                <tr
                  key={e.executionArn}
                  className={e.executionArn === activeArn ? "active" : undefined}
                  onClick={() => onOpen(e)}
                >
                  <td>
                    <div className="exec-name">{e.name}</div>
                    {e.description ? <div className="meta">{e.description}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${e.status}`}>{e.status}</span>
                  </td>
                  <td className="mono">{formatTs(e.startDate)}</td>
                  <td className="mono">{formatTs(e.stopDate)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatTs(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
