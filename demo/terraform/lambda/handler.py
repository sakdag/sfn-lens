"""Cheap demo Lambda for sfn-lens fault injection."""

from __future__ import annotations

import json
import time
from typing import Any


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    step = event.get("step", "unknown")
    fault = event.get("fault") or (event.get("Payload") or {}).get("fault")

    # Normalize if Step Functions wrapped the payload
    if isinstance(event.get("fault"), str):
        fault = event["fault"]

    if step == "validate":
        if fault == "reject":
            return {"ok": False, "fault": fault}
        return {"ok": True, "fault": fault}

    if step == "process":
        if fault == "lambda_error":
            raise RuntimeError("injected lambda failure")
        if fault == "timeout":
            time.sleep(10)
        if fault == "throttle":
            # Simulate a retryable service error once then succeed path via SFN retry config
            raise Exception("Rate exceeded")
        return {"ok": True, "fault": fault, "processed": True}

    if step == "map_item":
        item = event.get("item") or event
        if item.get("fail"):
            raise RuntimeError(f"map item failed: {json.dumps(item)}")
        return {"ok": True, "item": item}

    return {"ok": True, "step": step, "fault": fault}
