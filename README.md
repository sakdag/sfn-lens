# sfn-lens

Inspect AWS Step Functions executions **inside your AI chat**.

sfn-lens is an [MCP App](https://modelcontextprotocol.io/extensions/apps/overview): the model calls a tool, and Claude Desktop renders an interactive state-machine graph with status, duration, and the failed path highlighted. Bulky history stays in the UI; the model receives a compact structured summary. Click a state to load input/output/retries and update what the model knows for follow-up questions.

## Why TypeScript

The official MCP Apps SDK (`@modelcontextprotocol/ext-apps`) is TypeScript. The MCP server and the sandboxed view share one language and one build.

## Features

- ASL → graph (Task, Choice, Parallel, Map, Catch, Retry) with automatic layout
- Execution overlay: succeeded / failed / caught / retried / not run + duration
- Click-through state detail (app-only tools; default CSP stays closed — no direct AWS calls from the iframe)
- Compare two executions (path diff, duration deltas, first diverging state)
- **Read-only** by default (no redrive in v0.1)
- Redaction of configured JSONPath fields and common secret/PII keys before model or UI exposure
- **Fixture mode** for offline use and CI
- Cheap Terraform demo workflow + fault injection in `eu-north-1`

## Requirements

- Node.js 20+
- AWS credentials that can call Step Functions read APIs (profile `personal` by default)
- Claude Desktop (MCP Apps + stdio)

## Install (Claude Desktop)

```bash
git clone git@github.com:sakdag/sfn-lens.git
cd sfn-lens
npm install
npm run build
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sfn-lens": {
      "command": "node",
      "args": ["/ABS/PATH/TO/sfn-lens/packages/server/dist/index.js"],
      "env": {
        "AWS_PROFILE": "personal",
        "AWS_REGION": "eu-north-1"
      }
    }
  }
}
```

Restart Claude Desktop. Then ask: “Show me the latest failed Step Functions execution” or pass an execution ARN.

### Fixture mode (no AWS)

```json
"env": {
  "SFN_LENS_MODE": "fixture",
  "SFN_LENS_FIXTURE_DIR": "/ABS/PATH/TO/sfn-lens/fixtures"
}
```

Ask the assistant to `show_execution` with `fixtureId: "f1-lambda-error"`.

## Tools

| Tool | Visible to | Purpose |
| --- | --- | --- |
| `show_execution` | model + app | Graph + compact summary |
| `compare_executions` | model + app | Diff two runs |
| `list_state_machines` | model | Discover state machine ARNs |
| `list_executions` | model | Recent runs / fixtures for a machine |
| `get_state_detail` | app only | Input/output/retries for one state |
| `get_history_page` | app only | Paginated events for the UI |

## Demo workflow

```bash
cd demo/terraform
AWS_PROFILE=personal terraform init
AWS_PROFILE=personal terraform apply
export STATE_MACHINE_ARN=$(AWS_PROFILE=personal terraform output -raw state_machine_arn)
bash ../scripts/inject_faults.sh
```

Tear down with `terraform destroy` when finished. Lambdas are 128 MB / 3 s timeout to keep cost near zero.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `AWS_PROFILE` | `personal` | Shared credentials profile |
| `AWS_REGION` | `eu-north-1` | Region for the SFN client |
| `SFN_LENS_MODE` | `live` | `live` or `fixture` |
| `SFN_LENS_FIXTURE_DIR` | repo `fixtures/` | Fixture JSON directory |
| `SFN_LENS_REDACT_JSONPATHS` | _(empty)_ | Comma-separated paths, e.g. `$.customer.ssn` |

IAM: read-only Step Functions (`List*`, `Describe*`, `GetExecutionHistory`) on the account you point at. Any state machine is allowed; scope the policy tighter in shared accounts if you need to.

## Development

```bash
npm install
npm run build
npm test
npm run start:stdio   # for manual MCP checks
```

Eval notes: [`docs/EVAL.md`](docs/EVAL.md). Security notes: [`docs/SECURITY.md`](docs/SECURITY.md).

## Licence

Apache-2.0
