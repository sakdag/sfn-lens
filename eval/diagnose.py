#!/usr/bin/env python3
"""Diagnosis eval: real ExecutionSummary vs raw history on Bedrock Nova Micro."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"
RESULTS = Path(__file__).resolve().parent / "results"
SUMMARY_SCRIPT = Path(__file__).resolve().parent / "summary_from_fixture.mjs"
MODEL_ID = "eu.amazon.nova-micro-v1:0"

IN_RATE = 0.035
OUT_RATE = 0.14
COST_CEILING_USD = 1.0

# Prefer failing / diagnostic fixtures; skip pure success unless needed
PREFERRED = [
    "f1-lambda-error",
    "f2-timeout",
    "f3-throttle",
    "f4-map-partial",
    "f4-map-large",
    "f5-caught-then-fail",
    "f6-reject",
]


def load_fixtures(limit: int) -> list[tuple[Path, dict]]:
    by_id = {p.stem: p for p in FIXTURES.glob("*.json")}
    ordered: list[Path] = []
    for fid in PREFERRED:
        if fid in by_id:
            ordered.append(by_id.pop(fid))
    ordered.extend(sorted(by_id.values(), key=lambda p: p.name))
    selected = ordered[:limit]
    return [(p, json.loads(p.read_text())) for p in selected]


def estimate_cost(n_fixtures: int, n_conditions: int = 2) -> float:
    return n_fixtures * n_conditions * ((4000 * IN_RATE) + (400 * OUT_RATE)) / 1_000_000


def real_summary(fixture_path: Path) -> dict:
    """Build ExecutionSummary via the TypeScript core (not a Python rebuild)."""
    out = subprocess.check_output(
        ["node", str(SUMMARY_SCRIPT), str(fixture_path)],
        cwd=str(ROOT),
        text=True,
    )
    return json.loads(out)


def summary_prompt(summary: dict) -> str:
    # Only fields the product would send to the model — never gold labels
    payload = {
        "status": summary.get("status"),
        "failedState": summary.get("failedState"),
        "error": summary.get("error"),
        "cause": summary.get("cause"),
        "path": summary.get("path"),
        "retryCount": summary.get("retryCount"),
        "statesSummary": summary.get("statesSummary"),
        "historyTruncated": summary.get("historyTruncated"),
    }
    return (
        "You diagnose AWS Step Functions failures. Reply with JSON only: "
        '{"failedState":"...","errorClass":"...","rootCause":"..."}\n\n'
        f"SUMMARY:\n{json.dumps(payload)}"
    )


def raw_prompt(fix: dict) -> str:
    events = fix["history"]
    blob = json.dumps(events)[:12000]
    return (
        "You diagnose AWS Step Functions failures. Reply with JSON only: "
        '{"failedState":"...","errorClass":"...","rootCause":"..."}\n\n'
        f"RAW_HISTORY:\n{blob}"
    )


def parse_model_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return {"raw": text}
    blob = match.group(0)
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        # Common model glitch: trailing commas / truncated strings
        cleaned = re.sub(r",\s*}", "}", blob)
        cleaned = re.sub(r",\s*]", "]", cleaned)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return {"raw": text}


def call_bedrock(client, prompt: str) -> tuple[dict, int, int]:
    resp = client.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 400, "temperature": 0},
    )
    text = resp["output"]["message"]["content"][0]["text"]
    usage = resp.get("usage", {})
    inn = int(usage.get("inputTokens", 0))
    out = int(usage.get("outputTokens", 0))
    return parse_model_json(text), inn, out


def score(pred: dict, gold: dict) -> dict:
    fs = str(pred.get("failedState", "")).strip()
    ec = str(pred.get("errorClass", "")).strip()
    rc = str(pred.get("rootCause", "")).lower()
    gold_rc = str(gold.get("rootCause", "")).lower()
    gold_ec = str(gold.get("errorClass", ""))
    return {
        "failed_state_ok": fs == gold.get("failedState"),
        "error_class_ok": bool(ec) and (ec in gold_ec or gold_ec in ec),
        "root_cause_ok": bool(gold_rc) and gold_rc in rc,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--region", default=None)
    args = parser.parse_args()

    fixtures = load_fixtures(args.limit)
    if not fixtures:
        print("No fixtures found", file=sys.stderr)
        return 1

    # Verify real summary path works before spending Bedrock tokens
    for path, fix in fixtures:
        try:
            summary = real_summary(path)
        except Exception as e:
            print(f"Failed to build ExecutionSummary for {path.name}: {e}", file=sys.stderr)
            return 1
        if "gold" in summary:
            print("Summary must not contain gold labels", file=sys.stderr)
            return 1

    est = estimate_cost(len(fixtures))
    print(f"Fixtures: {len(fixtures)}; estimated upper-bound cost ≈ ${est:.4f}")
    if est > COST_CEILING_USD:
        print(f"Refusing to run: estimate exceeds ${COST_CEILING_USD}", file=sys.stderr)
        return 2

    if args.dry_run:
        for path, fix in fixtures:
            summary = real_summary(path)
            print(
                f"  {fix['id']}: status={summary.get('status')} "
                f"failedState={summary.get('failedState')} "
                f"events={len(fix['history'])} "
                f"summary_bytes={len(json.dumps(summary))} "
                f"raw_bytes={len(json.dumps(fix['history']))}"
            )
        return 0

    import boto3

    region = args.region or __import__("os").environ.get("AWS_REGION") or __import__("os").environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    client = boto3.client("bedrock-runtime", region_name=region)
    rows = []
    total_in = total_out = 0

    for path, fix in fixtures:
        gold = fix.get("gold") or {}
        summary = real_summary(path)
        for cond, prompt in [
            ("summary", summary_prompt(summary)),
            ("raw", raw_prompt(fix)),
        ]:
            pred, inn, out = call_bedrock(client, prompt)
            total_in += inn
            total_out += out
            sc = score(pred, gold)
            rows.append(
                {
                    "fixture": fix["id"],
                    "condition": cond,
                    "pred": pred,
                    "gold": gold,
                    "score": sc,
                    "inputTokens": inn,
                    "outputTokens": out,
                }
            )
            time.sleep(0.3)

    cost = (total_in * IN_RATE + total_out * OUT_RATE) / 1_000_000
    RESULTS.mkdir(parents=True, exist_ok=True)
    summary_out = {
        "model": MODEL_ID,
        "rows": rows,
        "totals": {"inputTokens": total_in, "outputTokens": total_out, "costUsd": round(cost, 6)},
    }
    out_path = RESULTS / "latest.json"
    out_path.write_text(json.dumps(summary_out, indent=2))
    print(json.dumps(summary_out["totals"], indent=2))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
