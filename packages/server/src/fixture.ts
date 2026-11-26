import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionFixture } from "@sfn-lens/core";

const DEFAULT_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

export function fixtureModeEnabled(): boolean {
  const mode = (process.env.SFN_LENS_MODE ?? "live").toLowerCase();
  return mode === "fixture" || mode === "fixtures";
}

export function fixtureDir(): string {
  return process.env.SFN_LENS_FIXTURE_DIR ?? DEFAULT_FIXTURE_DIR;
}

export async function loadFixture(id: string): Promise<ExecutionFixture> {
  const file = path.join(fixtureDir(), `${id}.json`);
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw) as ExecutionFixture;
}

export async function listFixtures(): Promise<
  Array<{ id: string; description: string; status: string; faultId?: string }>
> {
  const dir = fixtureDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ id: string; description: string; status: string; faultId?: string }> = [];
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const fix = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8")) as ExecutionFixture;
    out.push({
      id: fix.id,
      description: fix.description,
      status: fix.execution.status,
      faultId: fix.faultId,
    });
  }
  return out;
}

export async function findFixtureByArnOrName(
  executionArn?: string,
  name?: string,
): Promise<ExecutionFixture | undefined> {
  const dir = fixtureDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const fix = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8")) as ExecutionFixture;
    if (executionArn && fix.execution.executionArn === executionArn) return fix;
    if (name && fix.execution.name === name) return fix;
  }
  return undefined;
}
