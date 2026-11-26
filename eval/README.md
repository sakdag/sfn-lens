# Eval harness

Compares failed-state diagnosis when the model sees the real `ExecutionSummary` (from `@sfn-lens/core`) vs truncated raw `GetExecutionHistory`, on **recorded** demo fixtures (plus one synthetic large Map).

```bash
npm run build:core
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # boto3

# Cost estimate + summary sizes (no Bedrock calls)
npm run eval:dry

# Live Bedrock Nova Micro (uses AWS default credential chain)
npm run eval -- --limit 7
```

Cost guard: refuses to run if the estimated upper bound exceeds `$1.00`.

Results: `eval/results/latest.json`. Headline numbers and caveats: [`docs/EVAL.md`](../docs/EVAL.md).
