# Evaluation

Goal: measure whether the **compact execution summary** helps a model identify the failed state as well as raw history, at far lower token cost.

## Setup

- Model: Amazon Bedrock `eu.amazon.nova-micro-v1:0` (keep total spend under ~$1).
- Fixtures: mostly **recorded** from the live demo (`source: "recorded"`), plus one synthetic large Map (`f4-map-large`). Gold labels are for scoring only — never shown to the model.
- Conditions:
  - **A — summary:** model sees `ExecutionSummary` JSON only (from `@sfn-lens/core`)
  - **B — raw:** model sees truncated `GetExecutionHistory` events

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

## Latest run (Nova Micro, 6 recorded + 1 synthetic large Map)

**Headline:** summary got the failed state **7/7** vs raw **5/7**, at **3,443** vs **17,623** input tokens (~5× fewer).

| Condition | Failed-state | Input tokens |
| --- | --- | --- |
| Summary (`ExecutionSummary`) | 7/7 | 3,443 |
| Raw history (truncated) | 5/7 | 17,623 |

Cost ≈ $0.0008. With seven fixtures, secondary gaps are often a single case. Large Map fixture (`f4-map-large`, 331 events): summary stays compact while raw history dominates token count.
