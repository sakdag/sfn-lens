import type { StateDetail, StateOverlay } from "./types";

export function DetailPanel(props: {
  stateName?: string;
  overlay?: StateOverlay;
  detail?: StateDetail | null;
  loading?: boolean;
  executionError?: string;
  executionCause?: string;
}) {
  const { stateName, overlay, detail, loading, executionError, executionCause } = props;

  if (!stateName) {
    return (
      <div className="detail-pane">
        <h2>State detail</h2>
        <p className="empty">Click a state on the graph.</p>
        {(executionError || executionCause) && (
          <div className="detail-section">
            <div className="label">Execution error</div>
            <pre>{[executionError, executionCause].filter(Boolean).join("\n")}</pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="detail-pane">
      <h2>{stateName}</h2>
      <div className="detail-section">
        <span className={`badge ${detail?.status ?? overlay?.status ?? "NOT_RUN"}`}>
          {detail?.status ?? overlay?.status ?? "NOT_RUN"}
        </span>
        {detail?.type ? <span className="meta"> · {detail.type}</span> : null}
        {(detail?.durationMs ?? overlay?.durationMs) != null ? (
          <span className="meta"> · {detail?.durationMs ?? overlay?.durationMs} ms</span>
        ) : null}
      </div>

      {(detail?.error || overlay?.error) && (
        <div className="detail-section">
          <div className="label">Error</div>
          <pre>{detail?.error ?? overlay?.error}</pre>
        </div>
      )}
      {(detail?.cause || overlay?.cause) && (
        <div className="detail-section">
          <div className="label">Cause</div>
          <pre>{detail?.cause ?? overlay?.cause}</pre>
        </div>
      )}

      {loading ? <p className="meta">Loading input/output…</p> : null}

      {detail?.input !== undefined && (
        <div className="detail-section">
          <div className="label">Input</div>
          <pre>{JSON.stringify(detail.input, null, 2)}</pre>
        </div>
      )}
      {detail?.output !== undefined && (
        <div className="detail-section">
          <div className="label">Output</div>
          <pre>{JSON.stringify(detail.output, null, 2)}</pre>
        </div>
      )}
      {detail?.retries && detail.retries.length > 0 && (
        <div className="detail-section">
          <div className="label">Retries ({detail.retries.length})</div>
          <pre>{JSON.stringify(detail.retries, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
