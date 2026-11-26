#!/usr/bin/env python3
"""Diagnosis eval: compact summary vs raw history on Bedrock Nova Micro."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"
RESULTS = Path(__file__).resolve().parent / "results"
MODEL_ID = "eu.amazon.nova-micro-v1:0"

# Rough Nova Micro list rates (USD / 1M tokens) — upper-bound guard only
IN_RATE = 0.035
OUT_RATE = 0.14
COST_CEILING_USD = 1.0


def load_fixtures(limit: int) -> list[dict]:
    files = sorted(FIXTURES.glob("*.json"))[:limit]
    return [json.loads(p.read_text()) for p in files]


def estimate_cost(n_fixtures: int, n_conditions: int = 2) -> float:
    # pessimistic: 4k in + 400 out per call
    return n_fixtures * n_conditions * ((4000 * IN_RATE) + (400 * OUT_RATE)) / 1_000_000


def summary_prompt(fix: dict) -> str:
    from_summary = {
        "status": fix["execution"]["status"],
        "failedStateHint": fix.get("gold", {}).get("failedState"),
        "error": fix["execution"].get("error"),
        "cause": fix["execution"].get("cause"),
        "path": [e.get("stateEnteredEventDetails", {}).get("name") for e in fix["history"] if "StateEntered" in e.get("type", "")],
        "note": "This is a compact execution summary. Identify failed state, error class, root cause.",
    }
    # Prefer using gold-free fields only — strip gold from what model sees
    path = []
    for e in fix["history"]:
        details = e.get("stateEnteredEventDetails") or {}
        if details.get("name"):
            path.append(details["name"])
    payload = {
        "status": fix["execution"]["status"],
        "error": fix["execution"].get("error"),
        "cause": (fix["execution"].get("cause") or "")[:400],
        "path": path,
        "states": [
            {
                "name": e.get("stateEnteredEventDetails", {}).get("name"),
                "type": e.get("type"),
            }
            for e in fix["history"]
            if e.get("type", "").endswith("StateEntered")
        ],
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


def call_bedrock(client, prompt: str) -> tuple[dict, int, int]:
    resp = client.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 300, "temperature": 0},
    )
    text = resp["output"]["message"]["content"][0]["text"]
    usage = resp.get("usage", {})
    inn = int(usage.get("inputTokens", 0))
    out = int(usage.get("outputTokens", 0))
    match = re.search(r"\{.*\}", text, re.S)
    parsed = json.loads(match.group(0)) if match else {"raw": text}
    return parsed, inn, out


def score(pred: dict, gold: dict) -> dict:
    fs = str(pred.get("failedState", "")).strip()
    ec = str(pred.get("errorClass", "")).strip()
    rc = str(pred.get("rootCause", "")).lower()
    gold_rc = str(gold.get("rootCause", "")).lower()
    return {
        "failed_state_ok": fs == gold.get("failedState"),
        "error_class_ok": bool(ec) and ec in str(gold.get("errorClass", ""))
        or str(gold.get("errorClass", "")) in ec,
        "root_cause_ok": bool(gold_rc) and gold_rc in rc,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    fixtures = load_fixtures(args.limit)
    if not fixtures:
        print("No fixtures found", file=sys.stderr)
        return 1

    est = estimate_cost(len(fixtures))
    print(f"Fixtures: {len(fixtures)}; estimated upper-bound cost ≈ ${est:.4f}")
    if est > COST_CEILING_USD:
        print(f"Refusing to run: estimate exceeds ${COST_CEILING_USD}", file=sys.stderr)
        return 2

    if args.dry_run:
        return 0

    client = boto3.client("bedrock-runtime", region_name="eu-north-1")
    rows = []
    total_in = total_out = 0

    for fix in fixtures:
        gold = fix.get("gold") or {}
        for cond, prompt_fn in [("summary", summary_prompt), ("raw", raw_prompt)]:
            pred, inn, out = call_bedrock(client, prompt_fn(fix))
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
    summary = {
        "model": MODEL_ID,
        "rows": rows,
        "totals": {"inputTokens": total_in, "outputTokens": total_out, "costUsd": round(cost, 6)},
    }
    out_path = RESULTS / "latest.json"
    out_path.write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary["totals"], indent=2))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
