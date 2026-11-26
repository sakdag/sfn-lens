# Evaluation

Goal: measure whether the **compact execution summary** helps a model identify the failed state as well as raw history, at far lower token cost.

## Setup

- Model: Amazon Bedrock `eu.amazon.nova-micro-v1:0` (keep total spend under ~$1).
- Fixtures: synthetic `fixtures/*.json` (see [`fixtures/README.md`](../fixtures/README.md)) with gold labels for scoring only — gold is never shown to the model.
- Conditions:
  - **A — summary:** model sees `ExecutionSummary` JSON only (from `@sfn-lens/core`)
  - **B — raw:** model sees truncated `GetExecutionHistory` events (cap ~12k chars)

## Metrics

| Metric | Definition | Notes |
| --- | --- | --- |
| Failed-state accuracy | Predicted failing state name == gold | Primary metric |
| Error-class accuracy | Predicted error class matches gold (substring OK) | Secondary; n=7, one miss moves the score a lot |
| Input tokens | Prompt tokens per condition | Cost proxy |
| Root-cause hit | Gold phrase appears in answer | Tracked in `latest.json` but **not** headlined — the phrase often already sits in `cause` |

## Run

```bash
npm run eval:dry          # real ExecutionSummary sizes, no Bedrock
npm run eval -- --limit 7 # Bedrock Nova Micro (default AWS credentials)
```

Results: `eval/results/latest.json`. See [`eval/README.md`](../eval/README.md).

## Latest run (Nova Micro, 7 synthetic fixtures)

**Headline:** summary got the failed state **7/7** vs raw **6/7**, at **2,959** vs **12,043** input tokens (~4× fewer).

| Condition | Failed-state | Input tokens |
| --- | --- | --- |
| Summary (`ExecutionSummary`) | 7/7 | 2,959 |
| Raw history (truncated) | 6/7 | 12,043 |

Cost ≈ $0.0006. With seven fixtures, secondary gaps are often a single case — e.g. on `f4-map-partial`, raw matched the error class and summary did not. Large Map fixture (`f4-map-large`, 331 events): summary ~1.6KB vs raw ~61KB.
