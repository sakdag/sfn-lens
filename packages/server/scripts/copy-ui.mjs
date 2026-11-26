import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(root, "../view/dist/execution.html");
const destDir = path.join(root, "dist/ui");
const dest = path.join(destDir, "execution.html");

try {
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(src, dest);
  console.log(`Copied UI → ${dest}`);
} catch (err) {
  console.warn(`UI copy skipped (${err.message}). Build @sfn-lens/view first.`);
}
