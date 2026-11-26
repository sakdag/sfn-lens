# Evaluation

Goal: measure whether the **compact execution summary** helps a model diagnose failures as well as (or better than) raw history, at far lower token cost.

## Setup

- Model: Amazon Bedrock `eu.amazon.nova-micro-v1:0` (same family as related tooling; keep total spend under ~$1).
- Fixtures: `fixtures/*.json` with `gold.failedState`, `gold.errorClass`, `gold.rootCause`.
- Conditions:
  - **A — summary:** model sees `ExecutionSummary` JSON only
  - **B — raw:** model sees truncated `GetExecutionHistory` events (cap ~8k tokens)

## Metrics

| Metric | Definition |
| --- | --- |
| Failed-state accuracy | Predicted failing state name == gold |
| Error-class accuracy | Predicted error class matches gold (substring OK) |
| Root-cause hit | Gold root-cause phrase appears in answer (case-insensitive) |
| Input tokens | Prompt tokens per condition |
| Output tokens | Completion tokens per condition |
| Cost | Bedrock list rates for Nova Micro |

## Run

```bash
# after npm run build — harness lands in eval/ (see eval/README.md)
npm run eval -- --limit 6
```

Published numbers will be written to `eval/results/` once the harness is locked.
