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
npm run eval:dry          # real ExecutionSummary sizes, no Bedrock
npm run eval -- --limit 7 # Bedrock Nova Micro (default AWS credentials)
```

Results: `eval/results/latest.json`. See [`eval/README.md`](../eval/README.md).

## Latest run (Nova Micro, 7 fixtures)

| Condition | Failed-state | Error-class | Root-cause | Input tokens |
| --- | --- | --- | --- | --- |
| Summary (`ExecutionSummary`) | 7/7 | 5/7 | 7/7 | 2,959 |
| Raw history (truncated) | 6/7 | 4/7 | 6/7 | 12,043 |

Cost ≈ $0.0006. Summary matched or beat raw on every metric at ~4× fewer input tokens. Large Map fixture (`f4-map-large`, 331 events): summary ~1.6KB vs raw ~61KB.
