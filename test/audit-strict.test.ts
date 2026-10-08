import { test } from "node:test";
import assert from "node:assert/strict";
import { selectUnresolvedFiles } from "../src/audit.js";
import type { FileAuditResult } from "../src/audit.js";

/**
 * `--strict` gate logic.
 *
 * The gate must fire only for files that were detected as AI-shaped *and* not
 * humanized. It must NOT fire for a clean file, nor for a file that was skipped
 * because it was too large / barely changed (those score 0, not "AI").
 */

function file(over: Partial<FileAuditResult>): FileAuditResult {
  return {
    path: "src/x.ts",
    score: 0,
    threshold: 0.65,
    signals: [],
    rewritten: false,
    ...over,
  };
}

test("strict: a clean file (below threshold) is not unresolved", () => {
  const clean = file({ score: 0.4 });
  assert.deepEqual(selectUnresolvedFiles([clean]), []);
});

test("strict: a humanized file is not unresolved", () => {
  const done = file({ score: 0.9, rewritten: true });
  assert.deepEqual(selectUnresolvedFiles([done]), []);
});

test("strict: an AI-shaped file that was not rewritten is unresolved", () => {
  const stuck = file({ score: 0.9, skippedReason: "rewrite error: 500" });
  assert.equal(selectUnresolvedFiles([stuck]).length, 1);
});

test("strict: a guard-rejected AI file is unresolved", () => {
  const rejected = file({
    score: 0.8,
    skippedReason: "rewrite rejected (truncated)",
  });
  assert.equal(selectUnresolvedFiles([rejected]).length, 1);
});

test("strict: a file skipped for being too large (score 0) is not unresolved", () => {
  const tooBig = file({ score: 0, skippedReason: "file too large (5000 lines)" });
  assert.deepEqual(selectUnresolvedFiles([tooBig]), []);
});

test("strict: a file skipped for too few changed lines is not unresolved", () => {
  const tiny = file({ score: 0, skippedReason: "too few changed lines" });
  assert.deepEqual(selectUnresolvedFiles([tiny]), []);
});

test("strict: only the stuck files are selected from a mixed run", () => {
  const clean = file({ path: "a.ts", score: 0.2 });
  const done = file({ path: "b.ts", score: 0.9, rewritten: true });
  const stuck = file({ path: "c.ts", score: 0.75, skippedReason: "rewrite rejected (indent)" });
  const selected = selectUnresolvedFiles([clean, done, stuck]);
  assert.deepEqual(selected.map((f) => f.path), ["c.ts"]);
});
