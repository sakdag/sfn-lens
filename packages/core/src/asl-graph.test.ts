import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aslToGraph } from "./asl-graph.js";
import { overlayFromHistory } from "./history-overlay.js";
import { buildViewModel } from "./summary.js";
import { redactValue } from "./redaction.js";
import { compareOverlays } from "./compare.js";
import type { AslDefinition, HistoryEvent } from "./types.js";

const sampleDef: AslDefinition = {
  Comment: "demo",
  StartAt: "Validate",
  States: {
    Validate: {
      Type: "Task",
      Resource: "arn:aws:lambda:eu-north-1:123:function:validate",
      Next: "Route",
    },
    Route: {
      Type: "Choice",
      Choices: [{ Variable: "$.ok", BooleanEquals: true, Next: "Process" }],
      Default: "Reject",
    },
    Process: {
      Type: "Task",
      Resource: "arn:aws:lambda:eu-north-1:123:function:process",
      Retry: [{ ErrorEquals: ["States.ALL"], MaxAttempts: 2 }],
      Catch: [{ ErrorEquals: ["States.ALL"], Next: "HandleError" }],
      Next: "Done",
    },
    HandleError: { Type: "Pass", End: true },
    Reject: { Type: "Fail", Error: "Rejected", Cause: "validation failed" },
    Done: { Type: "Succeed" },
  },
};

describe("aslToGraph", () => {
  it("builds nodes and choice/catch edges", () => {
    const g = aslToGraph(sampleDef);
    assert.ok(g.nodes.some((n) => n.name === "Validate" && n.isStart));
    assert.ok(g.edges.some((e) => e.kind === "choice"));
    assert.ok(g.edges.some((e) => e.kind === "catch"));
    assert.ok(g.edges.some((e) => e.kind === "default"));
  });
});

describe("overlay + summary", () => {
  it("marks failed state from history", () => {
    const history: HistoryEvent[] = [
      { id: 1, type: "ExecutionStarted", timestamp: "2026-01-01T00:00:00Z" },
      {
        id: 2,
        type: "TaskStateEntered",
        timestamp: "2026-01-01T00:00:01Z",
        stateEnteredEventDetails: { name: "Validate" },
      },
      {
        id: 3,
        type: "TaskStateExited",
        timestamp: "2026-01-01T00:00:02Z",
        stateExitedEventDetails: { name: "Validate" },
      },
      {
        id: 4,
        type: "TaskStateEntered",
        timestamp: "2026-01-01T00:00:02Z",
        stateEnteredEventDetails: { name: "Process" },
      },
      {
        id: 5,
        type: "TaskFailed",
        timestamp: "2026-01-01T00:00:03Z",
        taskFailedEventDetails: { error: "States.TaskFailed", cause: "boom" },
      },
      {
        id: 6,
        type: "ExecutionFailed",
        timestamp: "2026-01-01T00:00:04Z",
        executionFailedEventDetails: { error: "States.TaskFailed", cause: "boom" },
      },
    ];

    const vm = buildViewModel({
      executionArn: "arn:aws:states:eu-north-1:123:execution:demo:run1",
      name: "run1",
      status: "FAILED",
      stateMachineArn: "arn:aws:states:eu-north-1:123:stateMachine:demo",
      startDate: "2026-01-01T00:00:00Z",
      stopDate: "2026-01-01T00:00:04Z",
      definition: sampleDef,
      history,
    });

    assert.equal(vm.summary.failedState, "Process");
    assert.equal(vm.overlay.states["Process"]?.status, "FAILED");
    assert.match(vm.summary.uiHint, /click/i);
  });
});

describe("redaction", () => {
  it("redacts default sensitive keys and json paths", () => {
    const out = redactValue(
      { customer: { email: "a@b.c", name: "Ada" }, ok: true },
      { jsonPaths: ["$.customer.name"] },
    ) as { customer: { email: string; name: string }; ok: boolean };
    assert.equal(out.customer.email, "[REDACTED]");
    assert.equal(out.customer.name, "[REDACTED]");
    assert.equal(out.ok, true);
  });
});

describe("compare", () => {
  it("finds first diverging state", () => {
    const left = overlayFromHistory(
      [
        {
          id: 1,
          type: "TaskStateEntered",
          timestamp: "2026-01-01T00:00:00Z",
          stateEnteredEventDetails: { name: "A" },
        },
        {
          id: 2,
          type: "TaskStateEntered",
          timestamp: "2026-01-01T00:00:01Z",
          stateEnteredEventDetails: { name: "B" },
        },
      ],
      { status: "SUCCEEDED", startDate: "2026-01-01T00:00:00Z", stopDate: "2026-01-01T00:00:02Z" },
    );
    const right = overlayFromHistory(
      [
        {
          id: 1,
          type: "TaskStateEntered",
          timestamp: "2026-01-01T00:00:00Z",
          stateEnteredEventDetails: { name: "A" },
        },
        {
          id: 2,
          type: "TaskStateEntered",
          timestamp: "2026-01-01T00:00:01Z",
          stateEnteredEventDetails: { name: "C" },
        },
      ],
      { status: "FAILED", startDate: "2026-01-01T00:00:00Z", stopDate: "2026-01-01T00:00:02Z" },
    );
    const cmp = compareOverlays({
      leftArn: "left",
      rightArn: "right",
      left,
      right,
    });
    assert.equal(cmp.firstDivergingState, "B");
  });
});
