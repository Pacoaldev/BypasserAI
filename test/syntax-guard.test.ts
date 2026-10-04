import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSyntax, isSyntaxInvalid } from "../src/syntax-guard.js";

// ---------------------------------------------------------------------------
// Regression suite for the "assembled Python file does not parse" incident.
//
// The conservative indent heuristic (looksIndentBroken) ignores a *single*
// mis-indented line — only systemic flattening trips it. In a large Python file
// reassembled from several LLM chunks, one such micro-misindentation produced an
// IndentationError that reached disk. These tests pin the real-parser backstop
// that rejects such content before it is spliced in.
//
// The Python cases assert against an actual interpreter when one is present on
// the machine; if none is found the guard reports "unavailable" and the tests
// skip those assertions (a commit must never fail because Python is missing).
// ---------------------------------------------------------------------------

const PY = "def f():\n    return 1\n";
const PY_BROKEN = "def f():\n    return 1\n  return 2\n";

test("checkSyntax: unsupported for languages without a local parser", () => {
  assert.equal(checkSyntax("const x = 1;", "x.ts").status, "unsupported");
  assert.equal(checkSyntax("func main() {}", "x.go").status, "unsupported");
  assert.equal(isSyntaxInvalid("const x = 1;", "x.ts"), false);
});

test("checkSyntax: validates JSON with the built-in parser", () => {
  assert.equal(checkSyntax('{"a": 1}', "x.json").status, "ok");
  const bad = checkSyntax('{"a": 1,}', "x.json");
  assert.equal(bad.status, "invalid");
});

test("checkSyntax: accepts well-formed Python (or reports unavailable)", () => {
  const res = checkSyntax(PY, "x.py");
  if (res.status === "unavailable") return; // no interpreter on this machine
  assert.equal(res.status, "ok");
});

test("checkSyntax: rejects Python with a broken indentation", () => {
  const res = checkSyntax(PY_BROKEN, "x.py");
  if (res.status === "unavailable") return;
  assert.equal(res.status, "invalid");
  assert.match(res.reason ?? "", /indent/i);
});

test("isSyntaxInvalid: true only for provably-broken supported files", () => {
  const broken = checkSyntax(PY_BROKEN, "x.py");
  if (broken.status === "unavailable") {
    // No interpreter: the predicate must stay non-blocking for everything.
    assert.equal(isSyntaxInvalid(PY_BROKEN, "x.py"), false);
    return;
  }
  assert.equal(isSyntaxInvalid(PY_BROKEN, "x.py"), true);
  assert.equal(isSyntaxInvalid(PY, "x.py"), false);
  assert.equal(isSyntaxInvalid("const x = 1;", "x.ts"), false);
});

test("checkSyntax: .pyi is treated as Python", () => {
  const res = checkSyntax(PY, "x.pyi");
  assert.notEqual(res.status, "unsupported");
});
