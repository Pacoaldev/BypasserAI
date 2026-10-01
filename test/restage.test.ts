import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restageFile } from "../src/git.js";

// ---------------------------------------------------------------------------
// Regression suite for the destructive-truncation incident.
//
// When the hook rewrites a file it must do so *safely*: the on-disk file must
// only ever change atomically, and a backup of the pre-rewrite content must be
// available so a bad rewrite can be recovered. Before this guard, a truncated
// model response was written straight over the original with no recovery path.
// ---------------------------------------------------------------------------

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bypasser-restage-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  return dir;
}

test("restageFile: writes new content and stages it", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "a.ts"], { cwd: dir });
    restageFile("a.ts", "export const a = 2;\n", dir);

    assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "export const a = 2;\n");
    const staged = execFileSync("git", ["show", ":a.ts"], { cwd: dir, encoding: "utf8" });
    assert.match(staged, /export const a = 2;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restageFile: leaves a .bak backup of the pre-rewrite content", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "a.ts"), "export const original = 1;\n");
    execFileSync("git", ["add", "a.ts"], { cwd: dir });
    restageFile("a.ts", "export const rewritten = 2;\n", dir);

    const backup = join(dir, "a.ts.bak");
    assert.ok(existsSync(backup), "a .bak backup must exist after a rewrite");
    assert.equal(readFileSync(backup, "utf8"), "export const original = 1;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restageFile: refuses to write an empty file over a non-empty original", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "a.ts"), "export const keepMe = 1;\n");
    execFileSync("git", ["add", "a.ts"], { cwd: dir });

    assert.throws(
      () => restageFile("a.ts", "", dir),
      /empty/i,
      "writing empty content over a non-empty file must throw"
    );

    // Original must be untouched.
    assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "export const keepMe = 1;\n");
    assert.ok(!existsSync(join(dir, "a.ts.bak")), "no backup should be made on abort");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
