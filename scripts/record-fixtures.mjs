#!/usr/bin/env node
/**
 * Record real GetExecutionHistory fixtures from the demo state machine.
 *
 * Usage:
 *   STATE_MACHINE_ARN=arn:... node scripts/record-fixtures.mjs
 *
 * Uses AWS SDK default credential chain. Writes fixtures/*.json with source:"recorded".
 */
import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures");

const GOLD_BY_PREFIX = {
  f1: {
    failedState: "ProcessFail",
    errorClass: "RuntimeError",
    rootCause: "injected lambda failure",
  },
  f2: {
    failedState: "ProcessFail",
    errorClass: "States.Timeout",
    rootCause: "States.Timeout",
  },
  f3: {
    failedState: "ProcessThrottle",
    errorClass: "Exception",
    rootCause: "Rate exceeded",
  },
  f4: {
    failedState: "MapItem",
    errorClass: "RuntimeError",
    rootCause: "map item failed",
  },
  f5: {
    failedState: "FailAfterCatch",
    errorClass: "CaughtThenFailed",
    rootCause: "failed deliberately",
  },
  f6: {
    failedState: "Reject",
    errorClass: "Rejected",
    rootCause: "validation rejected",
  },
  ok: {
    failedState: undefined,
    errorClass: undefined,
    rootCause: undefined,
  },
};

/** Scrub real account IDs before writing public fixtures. */
function scrubAccountIds(value) {
  const raw = JSON.stringify(value);
  const scrubbed = raw.replace(/:\d{12}:/g, ":000000000000:");
  return JSON.parse(scrubbed);
}

const FIXTURE_ID = {
  f1: "f1-lambda-error",
  f2: "f2-timeout",
  f3: "f3-throttle",
  f4: "f4-map-partial",
  f5: "f5-caught-then-fail",
  f6: "f6-reject",
  ok: "ok-success",
};

function prefixOf(name) {
  const m = /^(f[1-6]|ok)(?:-|$)/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

async function fetchAllHistory(client, executionArn) {
  const events = [];
  let nextToken;
  do {
    const page = await client.send(
      new GetExecutionHistoryCommand({
        executionArn,
        includeExecutionData: true,
        maxResults: 1000,
        nextToken,
        reverseOrder: false,
      }),
    );
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return events.map((e) => {
    const out = {
      id: e.id,
      type: e.type,
      timestamp: e.timestamp?.toISOString?.() ?? e.timestamp,
      previousEventId: e.previousEventId,
    };
    for (const [k, v] of Object.entries(e)) {
      if (k.endsWith("EventDetails") || k.endsWith("FailedEventDetails")) {
        out[k] = v;
      }
    }
    return out;
  });
}

async function main() {
  const arn = process.env.STATE_MACHINE_ARN;
  if (!arn) {
    console.error("Set STATE_MACHINE_ARN");
    process.exit(1);
  }
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const client = new SFNClient(region ? { region } : {});

  const sm = await client.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
  const definition = JSON.parse(sm.definition);

  const listed = await client.send(
    new ListExecutionsCommand({ stateMachineArn: arn, maxResults: 50 }),
  );

  /** @type {Map<string, import('@aws-sdk/client-sfn').ExecutionListItem>} */
  const latestByPrefix = new Map();
  for (const ex of listed.executions ?? []) {
    const p = prefixOf(ex.name ?? "");
    if (!p || latestByPrefix.has(p)) continue;
    latestByPrefix.set(p, ex);
  }

  for (const [prefix, id] of Object.entries(FIXTURE_ID)) {
    const ex = latestByPrefix.get(prefix);
    if (!ex?.executionArn) {
      console.warn(`skip ${id}: no execution with prefix ${prefix}`);
      continue;
    }
    const desc = await client.send(
      new DescribeExecutionCommand({ executionArn: ex.executionArn }),
    );
    const history = await fetchAllHistory(client, ex.executionArn);
    const gold = GOLD_BY_PREFIX[prefix];
    const fixture = {
      id,
      source: "recorded",
      description: `Recorded from ${ex.name} (${desc.status})`,
      faultId: prefix.toUpperCase() === "OK" ? "OK" : prefix.toUpperCase(),
      execution: {
        executionArn: desc.executionArn,
        name: desc.name,
        status: desc.status,
        stateMachineArn: desc.stateMachineArn,
        startDate: desc.startDate?.toISOString(),
        stopDate: desc.stopDate?.toISOString(),
        error: desc.error,
        cause: desc.cause,
        input: desc.input,
        output: desc.output,
      },
      definition,
      history,
      gold: gold?.failedState
        ? {
            failedState: gold.failedState,
            errorClass: gold.errorClass,
            rootCause: gold.rootCause,
          }
        : undefined,
    };
    const safe = scrubAccountIds(fixture);
    const file = path.join(OUT, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(safe, null, 2) + "\n");
    console.log(
      `wrote ${id}: status=${desc.status} events=${history.length} (account IDs scrubbed)`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
