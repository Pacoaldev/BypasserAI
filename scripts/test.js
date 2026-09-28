/**
 * Cross-platform test runner.
 *
 * Why this exists: Node's `--test` flag only accepts explicit file paths on
 * CI (globs and quoted patterns are passed literally to fs and fail). We
 * resolve the test files ourselves and pass concrete paths, so the command
 * behaves identically on Windows, macOS and Linux.
 *
 * Requires the `--import` hook (tsx v4 dropped `--loader`), which exists on
 * Node >=20.6. Tests therefore run on Node 20+, while the shipped CLI (plain
 * JS in dist/) still supports Node 18.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = resolve(here, "..", "test");

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => resolve(testsDir, f));

if (files.length === 0) {
  console.error("[bypasser] no *.test.ts files found in test/");
  process.exit(1);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 6)) {
  console.error(
    `[bypasser] tests need Node >=20.6 (tsx requires --import); running ${process.versions.node}. ` +
      "The shipped CLI still supports Node 18."
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);
