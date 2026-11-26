# Security

## Trust boundary

- The MCP App view runs in a **sandboxed iframe**. Default CSP keeps `connect-src` closed; the view does not call AWS (or any network) directly.
- All data reaches the view through **host-proxied** `tools/call` responses.
- Mutating APIs are off by default. **Redrive** is available only when `SFN_LENS_ALLOW_REDRIVE=true`, via an **app-only** tool that requires `confirm: true` after an explicit UI confirmation. Start-execution and stop are not exposed yet.

## Credentials

- Live mode uses the local AWS default provider chain (`AWS_PROFILE`, typically `personal`).
- Prefer a least-privilege IAM principal with only:

  - `states:ListStateMachines`
  - `states:ListExecutions`
  - `states:DescribeExecution`
  - `states:DescribeStateMachine`
  - `states:GetExecutionHistory`

## Redaction

- Before model summaries and UI detail tools, sfn-lens redacts:
  - Keys matching a built-in denylist (`password`, `secret`, `ssn`, `email`, `phone`, `apiKey`, …)
  - Paths in `SFN_LENS_REDACT_JSONPATHS`
- Redaction is best-effort. Nested or oddly named fields can still leak. Do not treat the tool as a compliance boundary for production PII.

## Hosts

Only connect sfn-lens from hosts you trust (e.g. Claude Desktop). The host can forward tool results into the model context.
