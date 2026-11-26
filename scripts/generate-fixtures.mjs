#!/usr/bin/env node
/**
 * Generate SYNTHETIC offline fixtures for the six injected faults + one large Map run.
 * These are not GetExecutionHistory downloads — see fixtures/README.md.
 * Run: node scripts/generate-fixtures.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures");
const LAMBDA = "arn:aws:lambda:eu-north-1:000000000000:function:sfn-lens-demo";
const SM = "arn:aws:states:eu-north-1:000000000000:stateMachine:sfn-lens-demo";

const definition = {
  Comment: "sfn-lens demo — cheap fault-injection workflow",
  StartAt: "Validate",
  States: {
    Validate: {
      Type: "Task",
      Resource: LAMBDA,
      Parameters: { step: "validate", "fault.$": "$.fault" },
      Next: "Route",
    },
    Route: {
      Type: "Choice",
      Choices: [{ Variable: "$.fault", StringEquals: "reject", Next: "Reject" }],
      Default: "MaybeMap",
    },
    MaybeMap: {
      Type: "Choice",
      Choices: [{ Variable: "$.fault", StringEquals: "map_partial", Next: "ProcessMap" }],
      Default: "Process",
    },
    ProcessMap: {
      Type: "Map",
      ItemsPath: "$.items",
      MaxConcurrency: 2,
      Iterator: {
        StartAt: "MapItem",
        States: {
          MapItem: {
            Type: "Task",
            Resource: LAMBDA,
            Parameters: { step: "map_item", "item.$": "$" },
            End: true,
          },
        },
      },
      Next: "Done",
    },
    Process: {
      Type: "Task",
      Resource: LAMBDA,
      Parameters: { step: "process", "fault.$": "$.fault" },
      Retry: [
        { ErrorEquals: ["States.ALL"], IntervalSeconds: 1, MaxAttempts: 2, BackoffRate: 1.5 },
      ],
      Catch: [{ ErrorEquals: ["States.ALL"], Next: "HandleError", ResultPath: "$.error" }],
      Next: "Done",
    },
    HandleError: {
      Type: "Choice",
      Choices: [
        { Variable: "$.fault", StringEquals: "caught_then_fail", Next: "FailAfterCatch" },
      ],
      Default: "Done",
    },
    FailAfterCatch: {
      Type: "Fail",
      Error: "CaughtThenFailed",
      Cause: "recovered from task error then failed deliberately",
    },
    Reject: { Type: "Fail", Error: "Rejected", Cause: "validation rejected" },
    Done: { Type: "Succeed" },
  },
};

function arn(name) {
  return `arn:aws:states:eu-north-1:000000000000:execution:sfn-lens-demo:${name}`;
}

function t(base, ms) {
  return new Date(Date.parse(base) + ms).toISOString();
}

const BASE = "2026-11-26T12:00:00.000Z";

function pathThroughValidateRoute(input, startId = 1) {
  const events = [];
  let id = startId;
  events.push({
    id: id++,
    type: "ExecutionStarted",
    timestamp: t(BASE, 0),
    executionStartedEventDetails: { input: JSON.stringify(input) },
  });
  events.push({
    id: id++,
    type: "TaskStateEntered",
    timestamp: t(BASE, 100),
    stateEnteredEventDetails: { name: "Validate", input: JSON.stringify(input) },
  });
  const validateOut = { ...input, ok: input.fault !== "reject" };
  events.push({
    id: id++,
    type: "TaskStateExited",
    timestamp: t(BASE, 400),
    stateExitedEventDetails: { name: "Validate", output: JSON.stringify(validateOut) },
  });
  events.push({
    id: id++,
    type: "ChoiceStateEntered",
    timestamp: t(BASE, 450),
    stateEnteredEventDetails: { name: "Route", input: JSON.stringify(validateOut) },
  });
  events.push({
    id: id++,
    type: "ChoiceStateExited",
    timestamp: t(BASE, 500),
    stateExitedEventDetails: { name: "Route", output: JSON.stringify(validateOut) },
  });
  return { events, id, state: validateOut };
}

function maybeMapChoice(events, id, state, nextIsMap) {
  events.push({
    id: id++,
    type: "ChoiceStateEntered",
    timestamp: t(BASE, 550),
    stateEnteredEventDetails: { name: "MaybeMap", input: JSON.stringify(state) },
  });
  events.push({
    id: id++,
    type: "ChoiceStateExited",
    timestamp: t(BASE, 600),
    stateExitedEventDetails: { name: "MaybeMap", output: JSON.stringify(state) },
  });
  return { id, nextIsMap };
}

function write(fix) {
  const payload = { source: "synthetic", ...fix };
  const file = path.join(OUT, `${fix.id}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
  console.log("wrote", path.relative(ROOT, file));
}

// --- F2 timeout ---
{
  const input = { fault: "timeout", claimantEmail: "bob@example.com" };
  const { events, id: id0, state } = pathThroughValidateRoute(input);
  let id = maybeMapChoice(events, id0, state).id;
  events.push({
    id: id++,
    type: "TaskStateEntered",
    timestamp: t(BASE, 650),
    stateEnteredEventDetails: { name: "Process", input: JSON.stringify(state) },
  });
  events.push({
    id: id++,
    type: "TaskTimedOut",
    timestamp: t(BASE, 3650),
    taskTimedOutEventDetails: {
      error: "States.Timeout",
      cause: "Task timed out after 3.00 seconds",
    },
  });
  // Catch → HandleError → Done (timeout is caught in demo ASL)
  events.push({
    id: id++,
    type: "TaskStateExited",
    timestamp: t(BASE, 3700),
    stateExitedEventDetails: {
      name: "Process",
      output: JSON.stringify({ ...state, error: { Error: "States.Timeout" } }),
    },
  });
  // Actually for timeout with Catch, SFN emits TaskTimedOut then catch transition.
  // For clearer gold (timeout at Process), model failure without catch completing:
  // Re-do F2 as TIMED_OUT execution where Catch doesn't apply to States.Timeout in some configs.
  // Demo Catch is States.ALL so it catches. Gold: failedState Process with caught path…
  // Better gold for operator diagnosis: Process timed out.
  events.push({
    id: id++,
    type: "ChoiceStateEntered",
    timestamp: t(BASE, 3750),
    stateEnteredEventDetails: {
      name: "HandleError",
      input: JSON.stringify({ ...state, error: { Error: "States.Timeout" } }),
    },
  });
  events.push({
    id: id++,
    type: "ChoiceStateExited",
    timestamp: t(BASE, 3800),
    stateExitedEventDetails: { name: "HandleError" },
  });
  events.push({
    id: id++,
    type: "SucceedStateEntered",
    timestamp: t(BASE, 3850),
    stateEnteredEventDetails: { name: "Done" },
  });
  events.push({
    id: id++,
    type: "SucceedStateExited",
    timestamp: t(BASE, 3900),
    stateExitedEventDetails: { name: "Done" },
  });
  events.push({
    id: id++,
    type: "ExecutionSucceeded",
    timestamp: t(BASE, 3950),
  });
  write({
    id: "f2-timeout",
    description: "Process task times out (caught, execution still succeeds via HandleError→Done)",
    faultId: "F2",
    execution: {
      executionArn: arn("f2-timeout"),
      name: "f2-timeout",
      status: "SUCCEEDED",
      stateMachineArn: SM,
      startDate: t(BASE, 0),
      stopDate: t(BASE, 3950),
    },
    definition,
    history: events,
    stateDetails: {
      Process: {
        input: state,
        error: "States.Timeout",
        cause: "Task timed out after 3.00 seconds",
      },
    },
    gold: {
      failedState: "Process",
      errorClass: "States.Timeout",
      rootCause: "timed out",
    },
  });
}

// --- F3 throttle (retries then catch → Done) ---
{
  const input = { fault: "throttle", customer: { ssn: "123-45-6789" } };
  const { events, id: id0, state } = pathThroughValidateRoute(input);
  let id = maybeMapChoice(events, id0, state).id;
  events.push({
    id: id++,
    type: "TaskStateEntered",
    timestamp: t(BASE, 650),
    stateEnteredEventDetails: { name: "Process", input: JSON.stringify(state) },
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    events.push({
      id: id++,
      type: "TaskFailed",
      timestamp: t(BASE, 800 + attempt * 200),
      taskFailedEventDetails: {
        error: "States.TaskFailed",
        cause: JSON.stringify({
          errorMessage: "Rate exceeded",
          claimantEmail: "throttle@example.com",
        }),
      },
    });
  }
  events.push({
    id: id++,
    type: "TaskStateExited",
    timestamp: t(BASE, 1500),
    stateExitedEventDetails: {
      name: "Process",
      output: JSON.stringify({ ...state, error: { Error: "States.TaskFailed" } }),
    },
  });
  events.push({
    id: id++,
    type: "ChoiceStateEntered",
    timestamp: t(BASE, 1550),
    stateEnteredEventDetails: { name: "HandleError" },
  });
  events.push({
    id: id++,
    type: "ChoiceStateExited",
    timestamp: t(BASE, 1600),
    stateExitedEventDetails: { name: "HandleError" },
  });
  events.push({
    id: id++,
    type: "SucceedStateEntered",
    timestamp: t(BASE, 1650),
    stateEnteredEventDetails: { name: "Done" },
  });
  events.push({
    id: id++,
    type: "SucceedStateExited",
    timestamp: t(BASE, 1700),
    stateExitedEventDetails: { name: "Done" },
  });
  events.push({ id: id++, type: "ExecutionSucceeded", timestamp: t(BASE, 1750) });
  write({
    id: "f3-throttle",
    description: "Process throttles, retries, then Catch routes to Done",
    faultId: "F3",
    execution: {
      executionArn: arn("f3-throttle"),
      name: "f3-throttle",
      status: "SUCCEEDED",
      stateMachineArn: SM,
      startDate: t(BASE, 0),
      stopDate: t(BASE, 1750),
    },
    definition,
    history: events,
    stateDetails: {
      Process: {
        input: state,
        error: "States.TaskFailed",
        cause: JSON.stringify({
          errorMessage: "Rate exceeded",
          claimantEmail: "throttle@example.com",
        }),
      },
    },
    gold: {
      failedState: "Process",
      errorClass: "States.TaskFailed",
      rootCause: "Rate exceeded",
    },
  });
}

// --- F4 map partial ---
{
  const items = [
    { id: 1 },
    { id: 2, fail: true, claimantEmail: "map-fail@example.com" },
    { id: 3 },
  ];
  const input = { fault: "map_partial", items };
  const { events, id: id0, state } = pathThroughValidateRoute(input);
  let id = maybeMapChoice(events, id0, state, true).id;
  events.push({
    id: id++,
    type: "MapStateEntered",
    timestamp: t(BASE, 650),
    stateEnteredEventDetails: { name: "ProcessMap", input: JSON.stringify(state) },
  });
  events.push({
    id: id++,
    type: "MapStateStarted",
    timestamp: t(BASE, 700),
    mapStateStartedEventDetails: { length: 3 },
  });
  // item 0 ok
  events.push({
    id: id++,
    type: "MapIterationStarted",
    timestamp: t(BASE, 750),
    mapIterationStartedEventDetails: { name: "ProcessMap", index: 0 },
  });
  events.push({
    id: id++,
    type: "TaskStateEntered",
    timestamp: t(BASE, 800),
    stateEnteredEventDetails: { name: "MapItem", input: JSON.stringify(items[0]) },
  });
  events.push({
    id: id++,
    type: "TaskStateExited",
    timestamp: t(BASE, 900),
    stateExitedEventDetails: {
      name: "MapItem",
      output: JSON.stringify({ ok: true, item: items[0] }),
    },
  });
  events.push({
    id: id++,
    type: "MapIterationSucceeded",
    timestamp: t(BASE, 950),
    mapIterationSucceededEventDetails: { name: "ProcessMap", index: 0 },
  });
  // item 1 fail
  events.push({
    id: id++,
    type: "MapIterationStarted",
    timestamp: t(BASE, 1000),
    mapIterationStartedEventDetails: { name: "ProcessMap", index: 1 },
  });
  events.push({
    id: id++,
    type: "TaskStateEntered",
    timestamp: t(BASE, 1050),
    stateEnteredEventDetails: { name: "MapItem", input: JSON.stringify(items[1]) },
  });
  const mapCause = JSON.stringify({
    errorType: "RuntimeError",
    errorMessage: `map item failed: ${JSON.stringify(items[1])}`,
  });
  events.push({
    id: id++,
    type: "TaskFailed",
    timestamp: t(BASE, 1200),
    taskFailedEventDetails: { error: "States.TaskFailed", cause: mapCause },
  });
  events.push({
    id: id++,
    type: "MapIterationFailed",
    timestamp: t(BASE, 1250),
    mapIterationFailedEventDetails: { name: "ProcessMap", index: 1 },
  });
  events.push({
    id: id++,
    type: "MapStateFailed",
    timestamp: t(BASE, 1300),
  });
  events.push({
    id: id++,
    type: "ExecutionFailed",
    timestamp: t(BASE, 1350),
    executionFailedEventDetails: { error: "States.TaskFailed", cause: mapCause },
  });
  write({
    id: "f4-map-partial",
    description: "Map ProcessMap fails on one item",
    faultId: "F4",
    execution: {
      executionArn: arn("f4-map-partial"),
      name: "f4-map-partial",
      status: "FAILED",
      stateMachineArn: SM,
      startDate: t(BASE, 0),
      stopDate: t(BASE, 1350),
      error: "States.TaskFailed",
      cause: mapCause,
    },
    definition,
    history: events,
    stateDetails: {
      MapItem: {
        input: items[1],
        error: "States.TaskFailed",
        cause: mapCause,
      },
    },
    gold: {
      failedState: "MapItem",
      errorClass: "States.TaskFailed",
      rootCause: "map item failed",
    },
  });
}

// --- F5 caught then fail ---
{
  const input = { fault: "caught_then_fail" };
  const { events, id: id0, state } = pathThroughValidateRoute(input);
  let id = maybeMapChoice(events, id0, state).id;
  events.push({
    id: id++,
    type: "TaskStateEntered",
    timestamp: t(BASE, 650),
    stateEnteredEventDetails: { name: "Process", input: JSON.stringify(state) },
  });
  events.push({
    id: id++,
    type: "TaskFailed",
    timestamp: t(BASE, 900),
    taskFailedEventDetails: {
      error: "States.TaskFailed",
      cause: JSON.stringify({ errorMessage: "injected for catch path" }),
    },
  });
  events.push({
    id: id++,
    type: "TaskStateExited",
    timestamp: t(BASE, 950),
    stateExitedEventDetails: {
      name: "Process",
      output: JSON.stringify({ ...state, error: { Error: "States.TaskFailed" } }),
    },
  });
  events.push({
    id: id++,
    type: "ChoiceStateEntered",
    timestamp: t(BASE, 1000),
    stateEnteredEventDetails: { name: "HandleError" },
  });
  events.push({
    id: id++,
    type: "ChoiceStateExited",
    timestamp: t(BASE, 1050),
    stateExitedEventDetails: { name: "HandleError" },
  });
  events.push({
    id: id++,
    type: "FailStateEntered",
    timestamp: t(BASE, 1100),
    stateEnteredEventDetails: { name: "FailAfterCatch" },
  });
  events.push({
    id: id++,
    type: "FailStateExited",
    timestamp: t(BASE, 1150),
    stateExitedEventDetails: { name: "FailAfterCatch" },
  });
  events.push({
    id: id++,
    type: "ExecutionFailed",
    timestamp: t(BASE, 1200),
    executionFailedEventDetails: {
      error: "CaughtThenFailed",
      cause: "recovered from task error then failed deliberately",
    },
  });
  write({
    id: "f5-caught-then-fail",
    description: "Process fails, Catch handles it, then FailAfterCatch fails the execution",
    faultId: "F5",
    execution: {
      executionArn: arn("f5-caught-then-fail"),
      name: "f5-caught-then-fail",
      status: "FAILED",
      stateMachineArn: SM,
      startDate: t(BASE, 0),
      stopDate: t(BASE, 1200),
      error: "CaughtThenFailed",
      cause: "recovered from task error then failed deliberately",
    },
    definition,
    history: events,
    gold: {
      failedState: "FailAfterCatch",
      errorClass: "CaughtThenFailed",
      rootCause: "failed deliberately",
    },
  });
}

// --- F6 reject ---
{
  const input = { fault: "reject" };
  const { events, id: id0, state } = pathThroughValidateRoute(input);
  let id = id0;
  events.push({
    id: id++,
    type: "FailStateEntered",
    timestamp: t(BASE, 550),
    stateEnteredEventDetails: { name: "Reject", input: JSON.stringify(state) },
  });
  events.push({
    id: id++,
    type: "FailStateExited",
    timestamp: t(BASE, 600),
    stateExitedEventDetails: { name: "Reject" },
  });
  events.push({
    id: id++,
    type: "ExecutionFailed",
    timestamp: t(BASE, 650),
    executionFailedEventDetails: {
      error: "Rejected",
      cause: "validation rejected",
    },
  });
  write({
    id: "f6-reject",
    description: "Choice Route sends fault=reject to Reject Fail state",
    faultId: "F6",
    execution: {
      executionArn: arn("f6-reject"),
      name: "f6-reject",
      status: "FAILED",
      stateMachineArn: SM,
      startDate: t(BASE, 0),
      stopDate: t(BASE, 650),
      error: "Rejected",
      cause: "validation rejected",
    },
    definition,
    history: events,
    gold: {
      failedState: "Reject",
      errorClass: "Rejected",
      rootCause: "validation rejected",
    },
  });
}

// --- Large Map run (many items, failure at the end) ---
{
  const itemCount = 80;
  const items = Array.from({ length: itemCount }, (_, i) =>
    i === itemCount - 1
      ? { id: i, fail: true, email: `item${i}@example.com` }
      : { id: i },
  );
  const input = { fault: "map_partial", items };
  const { events, id: id0, state } = pathThroughValidateRoute(input);
  let id = maybeMapChoice(events, id0, state, true).id;
  events.push({
    id: id++,
    type: "MapStateEntered",
    timestamp: t(BASE, 650),
    stateEnteredEventDetails: { name: "ProcessMap", input: JSON.stringify({ fault: "map_partial", items: `[${itemCount} items]` }) },
  });
  events.push({
    id: id++,
    type: "MapStateStarted",
    timestamp: t(BASE, 700),
    mapStateStartedEventDetails: { length: itemCount },
  });
  for (let i = 0; i < itemCount - 1; i++) {
    const ms = 800 + i * 40;
    events.push({
      id: id++,
      type: "MapIterationStarted",
      timestamp: t(BASE, ms),
      mapIterationStartedEventDetails: { name: "ProcessMap", index: i },
    });
    events.push({
      id: id++,
      type: "TaskStateEntered",
      timestamp: t(BASE, ms + 5),
      stateEnteredEventDetails: { name: "MapItem", input: JSON.stringify(items[i]) },
    });
    events.push({
      id: id++,
      type: "TaskStateExited",
      timestamp: t(BASE, ms + 20),
      stateExitedEventDetails: {
        name: "MapItem",
        output: JSON.stringify({ ok: true, item: items[i] }),
      },
    });
    events.push({
      id: id++,
      type: "MapIterationSucceeded",
      timestamp: t(BASE, ms + 30),
      mapIterationSucceededEventDetails: { name: "ProcessMap", index: i },
    });
  }
  const failItem = items[itemCount - 1];
  const failMs = 800 + (itemCount - 1) * 40;
  const mapCause = JSON.stringify({
    errorType: "RuntimeError",
    errorMessage: `map item failed: ${JSON.stringify(failItem)}`,
    claimantEmail: failItem.email,
  });
  events.push({
    id: id++,
    type: "MapIterationStarted",
    timestamp: t(BASE, failMs),
    mapIterationStartedEventDetails: { name: "ProcessMap", index: itemCount - 1 },
  });
  events.push({
    id: id++,
    type: "TaskStateEntered",
    timestamp: t(BASE, failMs + 5),
    stateEnteredEventDetails: { name: "MapItem", input: JSON.stringify(failItem) },
  });
  events.push({
    id: id++,
    type: "TaskFailed",
    timestamp: t(BASE, failMs + 25),
    taskFailedEventDetails: { error: "States.TaskFailed", cause: mapCause },
  });
  events.push({
    id: id++,
    type: "MapIterationFailed",
    timestamp: t(BASE, failMs + 30),
    mapIterationFailedEventDetails: { name: "ProcessMap", index: itemCount - 1 },
  });
  events.push({
    id: id++,
    type: "MapStateFailed",
    timestamp: t(BASE, failMs + 40),
  });
  events.push({
    id: id++,
    type: "ExecutionFailed",
    timestamp: t(BASE, failMs + 50),
    executionFailedEventDetails: { error: "States.TaskFailed", cause: mapCause },
  });
  write({
    id: "f4-map-large",
    description: `Large Map run (${itemCount} items); failure on the last item — stresses history tail`,
    faultId: "F4-LARGE",
    execution: {
      executionArn: arn("f4-map-large"),
      name: "f4-map-large",
      status: "FAILED",
      stateMachineArn: SM,
      startDate: t(BASE, 0),
      stopDate: t(BASE, failMs + 50),
      error: "States.TaskFailed",
      cause: mapCause,
    },
    definition,
    history: events,
    stateDetails: {
      MapItem: {
        input: failItem,
        error: "States.TaskFailed",
        cause: mapCause,
      },
    },
    gold: {
      failedState: "MapItem",
      errorClass: "States.TaskFailed",
      rootCause: "map item failed",
    },
  });
}

console.log("done");
