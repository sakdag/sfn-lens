# Fixtures

Offline execution JSON for fixture mode and the diagnosis eval.

| Id | Fault | Expected status |
| --- | --- | --- |
| `f1-lambda-error` | Uncaught Lambda failure on `ProcessFail` | `FAILED` |
| `f2-timeout` | Task timeout on `ProcessFail` | `TIMED_OUT` |
| `f3-throttle` | Retries exhausted on `ProcessThrottle` | `FAILED` |
| `f4-map-partial` | Map item failure | `FAILED` |
| `f4-map-large` | Large Map (synthetic); failure on last item | `FAILED` |
| `f5-caught-then-fail` | Catch then `FailAfterCatch` | `FAILED` |
| `f6-reject` | Choice → `Reject` | `FAILED` |
| `ok-success` | Happy path | `SUCCEEDED` |

Each file has `"source": "recorded"` (from a real `GetExecutionHistory`) or `"source": "synthetic"`.

## Record from the live demo

```bash
cd demo/terraform && terraform apply
export STATE_MACHINE_ARN=$(terraform output -raw state_machine_arn)
bash ../scripts/inject_faults.sh
# optional large Map (kept synthetic by default — expensive):
# aws stepfunctions start-execution --state-machine-arn "$STATE_MACHINE_ARN" \
#   --name "f4large-$(date +%s)" --input '{"fault":"map_partial","items":[...]}'

cd ../..
npm run fixtures:record
```

## Synthetic generator

`npm run fixtures:generate` rebuilds scripted histories (useful without AWS). Prefer recorded fixtures when sharing eval numbers.
