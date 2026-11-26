export function DefinitionPanel(props: {
  name?: string;
  stateMachineArn?: string;
  type?: string;
  status?: string;
  roleArn?: string;
  definitionText?: string;
  loading?: boolean;
}) {
  const { name, stateMachineArn, type, status, roleArn, definitionText, loading } = props;

  if (loading) {
    return (
      <div className="console-panel">
        <p className="meta">Loading definition…</p>
      </div>
    );
  }

  if (!definitionText) {
    return (
      <div className="console-panel">
        <p className="empty">No definition loaded. Open an execution or ask for get_definition.</p>
      </div>
    );
  }

  return (
    <div className="console-panel definition-panel">
      <div className="definition-meta">
        {name ? <div><strong>{name}</strong></div> : null}
        {stateMachineArn ? <div className="meta mono">{stateMachineArn}</div> : null}
        <div className="meta">
          {[type, status].filter(Boolean).join(" · ")}
          {roleArn ? ` · ${roleArn}` : ""}
        </div>
      </div>
      <pre className="definition-pre">{definitionText}</pre>
    </div>
  );
}
