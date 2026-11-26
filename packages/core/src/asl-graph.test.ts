import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aslToGraph } from "./asl-graph.js";
import { overlayFromHistory } from "./history-overlay.js";
import { layoutGraph } from "./layout.js";
import { buildViewModel } from "./summary.js";
import { pathPatternToRegExp, redactErrorCause, redactValue } from "./redaction.js";
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

describe("layout", () => {
  it("places Map iterator children beside the Map, not over Done", () => {
    const def: AslDefinition = {
      StartAt: "ProcessMap",
      States: {
        ProcessMap: {
          Type: "Map",
          ItemsPath: "$.items",
          Iterator: {
            StartAt: "MapItem",
            States: { MapItem: { Type: "Pass", End: true } },
          },
          Next: "Done",
        },
        Done: { Type: "Succeed" },
      },
    };
    const laid = layoutGraph(aslToGraph(def));
    const map = laid.nodes.find((n) => n.name === "ProcessMap")!;
    const item = laid.nodes.find((n) => n.name === "MapItem")!;
    const done = laid.nodes.find((n) => n.name === "Done")!;
    assert.ok(item.x >= map.x + map.width, "MapItem should sit to the right of ProcessMap");
    const overlapX =
      item.x < done.x + done.width && item.x + item.width > done.x;
    const overlapY =
      item.y < done.y + done.height && item.y + item.height > done.y;
    assert.equal(overlapX && overlapY, false, "MapItem must not overlap Done");
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

  it("flags historyTruncated on the summary", () => {
    const vm = buildViewModel({
      executionArn: "arn:aws:states:eu-north-1:123:execution:demo:run1",
      name: "run1",
      status: "FAILED",
      stateMachineArn: "arn:aws:states:eu-north-1:123:stateMachine:demo",
      definition: sampleDef,
      history: [
        {
          id: 1,
          type: "TaskStateEntered",
          timestamp: "2026-01-01T00:00:00Z",
          stateEnteredEventDetails: { name: "Process" },
        },
        {
          id: 2,
          type: "TaskFailed",
          timestamp: "2026-01-01T00:00:01Z",
          taskFailedEventDetails: { error: "States.TaskFailed", cause: "tail" },
        },
      ],
      historyTruncated: true,
    });
    assert.equal(vm.summary.historyTruncated, true);
    assert.equal(vm.summary.failedState, "Process");
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

  it("matches wildcard JSONPath $.items[*].ssn (escaped $)", () => {
    const re = pathPatternToRegExp("$.items[*].ssn");
    assert.equal(re.test("$.items[0].ssn"), true);
    assert.equal(re.test("$.items[12].ssn"), true);
    assert.equal(re.test("$.items.ssn"), false);

    const out = redactValue(
      { items: [{ ssn: "111-22-3333", id: 1 }, { ssn: "999-88-7777", id: 2 }] },
      { jsonPaths: ["$.items[*].ssn"] },
    ) as { items: Array<{ ssn: string; id: number }> };
    assert.equal(out.items[0]!.ssn, "[REDACTED]");
    assert.equal(out.items[1]!.ssn, "[REDACTED]");
    assert.equal(out.items[0]!.id, 1);
  });

  it("redacts claimantEmail via email key matching", () => {
    const out = redactValue({
      claimantEmail: "ada@example.com",
      name: "Ada",
    }) as { claimantEmail: string; name: string };
    assert.equal(out.claimantEmail, "[REDACTED]");
    assert.equal(out.name, "Ada");
  });

  it("redacts JSON Lambda causes without [object Object]", () => {
    const cause = JSON.stringify({
      errorType: "RuntimeError",
      errorMessage: "boom",
      claimantEmail: "x@y.z",
      customer: { ssn: "123-45-6789" },
    });
    const redacted = redactErrorCause(cause);
    assert.ok(redacted);
    assert.equal(redacted!.includes("[object Object]"), false);
    assert.equal(redacted!.includes("x@y.z"), false);
    assert.equal(redacted!.includes("123-45-6789"), false);
    assert.match(redacted!, /REDACTED/);
    const parsed = JSON.parse(redacted!);
    assert.equal(parsed.errorMessage, "boom");
  });

  it("scrubs emails in plain-text causes", () => {
    const out = redactErrorCause("failed for user ada@example.com");
    assert.equal(out, "failed for user [REDACTED]");
  });

  it("scrubs emails embedded inside Lambda errorMessage strings", () => {
    const cause = JSON.stringify({
      errorMessage: 'bad input {"email":"a@b.com"}',
    });
    const redacted = redactErrorCause(cause);
    assert.ok(redacted);
    assert.equal(redacted!.includes("a@b.com"), false);
    assert.match(redacted!, /REDACTED/);
    const parsed = JSON.parse(redacted!);
    assert.equal(parsed.errorMessage, "bad input {\"email\":\"[REDACTED]\"}");
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
