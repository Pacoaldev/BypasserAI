import { test } from "node:test";
import assert from "node:assert/strict";
import { looksIndentBroken } from "../src/rewrite-validate.js";

// ---------------------------------------------------------------------------
// Regression suite for the "flattened indentation" incident.
//
// The chunk/diff assembly can produce code whose tokens are all present and
// whose brackets balance, yet whose leading whitespace is destroyed — a
// statement that belongs inside a function comes back at column 0. This
// passes every other guard (brackets, declarations, line count) but is
// structurally wrong. looksIndentBroken must catch the systemic case without
// false-positiving on a legitimate one-line reflow.
// ---------------------------------------------------------------------------

const WELL_INDENTED = [
  "function outer() {",
  "  const a = 1;",
  "  if (a) {",
  "    return a;",
  "  }",
  "  return 0;",
  "}",
].join("\n");

test("looksIndentBroken: flags a fully flattened rewrite", () => {
  const flattened = [
    "function outer() {",
    "const a = 1;",
    "if (a) {",
    "return a;",
    "}",
    "return 0;",
    "}",
  ].join("\n");
  assert.equal(looksIndentBroken(WELL_INDENTED, flattened), true);
});

test("looksIndentBroken: accepts a legitimate rewrite that keeps indentation", () => {
  const rewritten = [
    "function outer() {",
    "  const value = 1;",
    "  if (value) return value;",
    "  return 0;",
    "}",
  ].join("\n");
  assert.equal(looksIndentBroken(WELL_INDENTED, rewritten), false);
});

test("looksIndentBroken: tolerates a single reflowed line", () => {
  const oneLineFlattened = [
    "function outer() {",
    "  const a = 1;",
    "  if (a) {",
    "  return a;", // one line lost its indent — not systemic
    "  }",
    "  return 0;",
    "}",
  ].join("\n");
  assert.equal(looksIndentBroken(WELL_INDENTED, oneLineFlattened), false);
});

test("looksIndentBroken: ignores files with no indentation (flat data)", () => {
  const flat = ["{", '"a": 1,', '"b": 2,', "}"].join("\n");
  const alsoFlat = ["{", '"a": 3,', '"b": 4,', "}"].join("\n");
  assert.equal(looksIndentBroken(flat, alsoFlat), false);
});

test("looksIndentBroken: ignores a flat original even if the rewrite indents", () => {
  const flat = ["a", "b", "c", "d"].join("\n");
  const indented = ["  a", "  b", "  c", "  d"].join("\n");
  assert.equal(looksIndentBroken(flat, indented), false);
});

test("looksIndentBroken: handles tab-indented originals", () => {
  const tabs = [
    "function outer() {",
    "\tconst a = 1;",
    "\tif (a) {",
    "\t\treturn a;",
    "\t}",
    "\treturn 0;",
    "}",
  ].join("\n");
  const flattened = [
    "function outer() {",
    "const a = 1;",
    "if (a) {",
    "return a;",
    "}",
    "return 0;",
    "}",
  ].join("\n");
  assert.equal(looksIndentBroken(tabs, flattened), true);
});
