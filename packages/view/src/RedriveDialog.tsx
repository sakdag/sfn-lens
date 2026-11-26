export function RedriveDialog(props: {
  executionName: string;
  executionArn: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { executionName, executionArn, busy, error, onCancel, onConfirm } = props;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="redrive-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="redrive-title">Redrive execution?</h2>
        <p>
          This restarts <strong>{executionName}</strong> from the unsuccessful step using the same
          input. Successful steps are not re-run. Same execution ARN is kept.
        </p>
        <p className="meta mono">{executionArn}</p>
        {error ? <p className="error-banner">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Redriving…" : "Confirm redrive"}
          </button>
        </div>
      </div>
    </div>
  );
}
