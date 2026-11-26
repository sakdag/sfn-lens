#!/usr/bin/env node
/**
 * Print the real ExecutionSummary JSON for a fixture (uses @sfn-lens/core).
 * Usage: node eval/summary_from_fixture.mjs path/to/fixture.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Prefer built package
const corePath = path.join(ROOT, "packages/core/dist/index.js");
if (!fs.existsSync(corePath)) {
  console.error("Build core first: npm run build:core");
  process.exit(1);
}

const { buildViewModel } = await import(corePath);

const file = process.argv[2];
if (!file) {
  console.error("Usage: node eval/summary_from_fixture.mjs <fixture.json>");
  process.exit(1);
}

const fix = JSON.parse(fs.readFileSync(file, "utf8"));
const vm = buildViewModel({
  executionArn: fix.execution.executionArn,
  name: fix.execution.name,
  status: fix.execution.status,
  stateMachineArn: fix.execution.stateMachineArn,
  startDate: fix.execution.startDate,
  stopDate: fix.execution.stopDate,
  error: fix.execution.error,
  cause: fix.execution.cause,
  definition: fix.definition,
  history: fix.history,
});

// Strip uiHint noise for the model prompt; keep diagnosis fields
const { uiHint: _ui, ...summary } = vm.summary;
console.log(JSON.stringify(summary));
