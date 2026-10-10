import { test } from "node:test";
import assert from "node:assert/strict";
import { looksStubbed, looksStructurallyBroken } from "../src/rewrite-validate.js";

// ---------------------------------------------------------------------------
// Regression suite for the "stubbed rewrite" corruption.
//
// Some models (observed on zd/claude-sonnet-4-5) replace a function body with a
// stub when they cannot rewrite it:
//
//     results = [lead for lead in ...]
//     # [1 lines omitted]
//     pass
//
// The real `return [...]` / `raise ...` is gone, so the function silently
// returns None. It still PARSES (pass is valid Python), so neither the syntax
// guard nor the line-collapse guard catch it — the corruption reached the
// commit. `looksStubbed` rejects these markers deterministically.
// ---------------------------------------------------------------------------

test("looksStubbed: flags an explicit 'lines omitted' marker (Python # form)", () => {
  const code = [
    "def list_leads():",
    "    results = _leads.values()",
    "    # [1 lines omitted]",
    "    pass",
  ].join("\n");
  assert.equal(looksStubbed(code), true);
});

test("looksStubbed: flags a '// [N lines omitted]' marker (C-style)", () => {
  const code = [
    "function list() {",
    "  const results = [];",
    "  // [3 lines omitted]",
    "}",
  ].join("\n");
  assert.equal(looksStubbed(code), true);
});

test("looksStubbed: flags a bare '[N lines omitted]' banner", () => {
  assert.equal(looksStubbed("const x = 1;\n[2 lines omitted]\nreturn x;"), true);
});

test("looksStubbed: flags the '... omitted' ellipsis form", () => {
  assert.equal(looksStubbed("def f():\n    ... omitted\n    pass\n"), true);
  assert.equal(looksStubbed("function f() {\n  // ... omitted\n}\n"), true);
});

test("looksStubbed: does NOT flag clean code that mentions 'omitted' in prose", () => {
  // A real comment describing behaviour must not trip the guard.
  const code = [
    "def f(options):",
    '    """Return the first option; omitted keys fall back to defaults."""',
    "    return options.get('first', None)",
  ].join("\n");
  assert.equal(looksStubbed(code), false);
});

test("looksStubbed: does NOT flag ordinary code", () => {
  const code = [
    "export function sum(xs: number[]): number {",
    "  let total = 0;",
    "  for (const x of xs) total += x;",
    "  return total;",
    "}",
  ].join("\n");
  assert.equal(looksStubbed(code), false);
});

test("looksStructurallyBroken still works alongside the new guard", () => {
  const before = ["function a() {}", "function b() {}", "function c() {}", "function d() {}"].join("\n");
  const after = "function a() {}";
  assert.equal(looksStructurallyBroken(before, after, "src/x.ts"), true);
});
