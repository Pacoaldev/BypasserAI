import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHunkRanges,
  mergeHunkRanges,
  sliceWithContext,
  spliceSlice,
  addedLineFraction,
} from "../src/diff-hunks.js";
import { splitCachedDiffByPath } from "../src/git.js";

test("parseHunkRanges reads new-file line spans", () => {
  const diff = [
    "@@ -1,3 +1,4 @@",
    " line1",
    "-old",
    "+new",
    "+extra",
  ].join("\n");
  const ranges = parseHunkRanges(diff);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].newStart, 1);
  assert.ok(ranges[0].newEnd >= 2);
});

test("spliceSlice replaces a line range", () => {
  const content = "a\nb\nc\nd\n";
  const out = spliceSlice(content, 2, 3, "B\nC");
  assert.equal(out, "a\nB\nC\nd\n");
});

test("splitCachedDiffByPath splits a combined cached diff", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,2 @@",
    "+x",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 333..444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1,2 @@",
    "+y",
  ].join("\n");
  const map = splitCachedDiffByPath(patch);
  assert.equal(map.size, 2);
  assert.ok(map.get("src/a.ts")?.includes("+x"));
  assert.ok(map.get("src/b.ts")?.includes("+y"));
});

test("addedLineFraction estimates new content ratio", () => {
  const diff = "+line\n+line\n+line\n";
  assert.equal(addedLineFraction(diff, 100), 0.03);
});

test("mergeHunkRanges merges close hunks", () => {
  const merged = mergeHunkRanges(
    [
      { newStart: 10, newEnd: 12 },
      { newStart: 14, newEnd: 15 },
    ],
    5
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].newEnd, 15);
});

test("sliceWithContext includes padding lines", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
  const { slice, startLine, endLine } = sliceWithContext(
    lines,
    { newStart: 10, newEnd: 11 },
    2
  );
  assert.equal(startLine, 8);
  assert.equal(endLine, 13);
  assert.match(slice, /L8/);
  assert.match(slice, /L13/);
});
