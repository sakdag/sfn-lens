# Fixtures

These JSON files are **synthetic** offline histories for fixture mode and the diagnosis eval.

They are produced by `scripts/generate-fixtures.mjs` (fake account `000000000000`, scripted event sequences that mirror the demo ASL faults). They are **not** downloads from `GetExecutionHistory`.

| Id | Fault |
| --- | --- |
| `f1-lambda-error` | Uncaught Lambda failure on `Process` |
| `f2-timeout` | Task timeout on `Process` (caught → Done) |
| `f3-throttle` | Retries then Catch → Done |
| `f4-map-partial` | Map item failure |
| `f4-map-large` | Large Map (80 items); failure on the last item |
| `f5-caught-then-fail` | Catch then `FailAfterCatch` |
| `f6-reject` | Choice → `Reject` |
| `ok-success` | Happy path |

To regenerate:

```bash
npm run fixtures:generate
```

To replace with real recordings later: deploy `demo/terraform`, run `demo/scripts/inject_faults.sh`, then save each execution’s definition + history into this directory (same schema, with real account ARNs).
