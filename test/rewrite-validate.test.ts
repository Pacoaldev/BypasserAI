import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksDocstringsStripped,
  looksLintPragmaAdded,
  looksStubbed,
  looksStructurallyBroken,
} from "../src/rewrite-validate.js";

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

// ---------------------------------------------------------------------------
// Regression suite for semantic-damage rewrites: docstrings turned into
// comments, and lint-suppression pragmas duplicated by the model.
//
// A humanizer project that lints with pylint makes the model "fix" warnings it
// did not have, by appending `# pylint: disable=…` on every commit and by
// "simplifying" `def f():` + `"""doc."""` into `def f():` + `# doc.` — which in
// Python is not a cosmetic edit: the docstring is the function's `__doc__`, so
// `help()`, pydoc, Sphinx and FastAPI's OpenAPI schema all lose it. The file
// still parses, so `checkSyntax` and every bracket guard stay green.
// ---------------------------------------------------------------------------

test("looksDocstringsStripped: flags a Python docstring turned into a comment", () => {
  const before = [
    "class FakeClient:",
    '    """Minimal HTTP double."""',
    "",
    "    def _resp(self, status: int) -> dict:",
    '        """Return a response body."""',
    "        return {\"status\": status}",
  ].join("\n");
  const after = [
    "class FakeClient:",
    "    # Minimal HTTP double.",
    "",
    "    def _resp(self, status: int) -> dict:",
    "        # Return a response body.",
    "        return {\"status\": status}",
  ].join("\n");
  assert.equal(looksDocstringsStripped(before, after, "tests/fake.py"), true);
});

test("looksDocstringsStripped: a reworded docstring kept as a docstring is fine", () => {
  const before = [
    "def fetch(url: str) -> bytes:",
    '    """Fetch the raw body."""',
    "    return _get(url)",
  ].join("\n");
  const after = [
    "def fetch(url: str) -> bytes:",
    '    """Return the raw body for url."""',
    "    return _get(url)",
  ].join("\n");
  assert.equal(looksDocstringsStripped(before, after, "app/fetch.py"), false);
});

test("looksDocstringsStripped: dropping JSDoc is the humanizer's job, not damage", () => {
  const before = [
    "/** Sum the numbers. */",
    "export function sum(xs: number[]): number {",
    "  return xs.reduce((a, b) => a + b, 0);",
    "}",
  ].join("\n");
  const after = ["export function sum(xs: number[]): number {", "  return xs.reduce((a, b) => a + b, 0);", "}"].join("\n");
  assert.equal(looksDocstringsStripped(before, after, "src/sum.ts"), false);
});

test("looksDocstringsStripped: flags a file that OPENS on a def with its docstring stripped", () => {
  // Regression: a suite header was consumed as the pending module docstring
  // position, so a file whose only docstring sat in its first suite counted
  // zero docstrings and its deletion went unnoticed.
  const before = ["def run(cur):", '    """Run the query."""', "    cur.execute(Q)", "    return cur"].join("\n");
  const after = ["def run(cur):", "    # Run the query.", "    cur.execute(Q)", "    return cur"].join("\n");
  assert.equal(looksDocstringsStripped(before, after, "app/run.py"), true);
});

test("looksDocstringsStripped: counts a docstring behind a decorator", () => {
  const before = [
    "class C:",
    "",
    "    @property",
    "    def name(self):",
    '        """The name."""',
    "        return self._name",
  ].join("\n");
  const after = [
    "class C:",
    "",
    "    @property",
    "    def name(self):",
    "        # The name.",
    "        return self._name",
  ].join("\n");
  assert.equal(looksDocstringsStripped(before, after, "app/c.py"), true);
});

test("looksDocstringsStripped: a file that had no docstring is never flagged", () => {
  const before = ["def add(a, b):", "    return a + b", "", "def sub(a, b):", "    return a - b"].join("\n");
  const after = ["def add(a, b):", "    return a + b"].join("\n");
  assert.equal(looksDocstringsStripped(before, after, "app/math.py"), false);
});

test("looksDocstringsStripped: dropping only ONE of three docstrings is flagged", () => {
  const before = [
    '"""Module docs."""',
    "import os",
    "",
    "",
    "def a():",
    '    """A."""',
    "",
    "",
    "def b():",
    '    """B."""',
  ].join("\n");
  const after = [
    "import os",
    "",
    "",
    "def a():",
    '    """A."""',
    "",
    "",
    "def b():",
    '    """B."""',
  ].join("\n");
  assert.equal(looksDocstringsStripped(before, after, "app/m.py"), true);
});

test("looksLintPragmaAdded: flags a newly injected pylint disable", () => {
  const before = ["def add(a, b):", "    return a + b"].join("\n");
  const after = ["# pylint: disable=too-many-arguments", "def add(a, b):", "    return a + b"].join("\n");
  assert.equal(looksLintPragmaAdded(before, after, "app/x.py"), true);
});

test("looksLintPragmaAdded: flags a DUPLICATED pragma the file already had", () => {
  const before = ["# pylint: disable=too-many-arguments", "def add(a, b):", "    return a + b"].join("\n");
  const after = [
    "# pylint: disable=too-many-arguments",
    "# pylint: disable=too-many-arguments",
    "def add(a, b):",
    "    return a + b",
  ].join("\n");
  assert.equal(looksLintPragmaAdded(before, after, "app/x.py"), true);
});

test("looksLintPragmaAdded: flags a trailing pragma on a code line", () => {
  const before = ["x = 1"].join("\n");
  const after = ["x = 1  # noqa: E501"].join("\n");
  assert.equal(looksLintPragmaAdded(before, after, "app/x.py"), true);
});

test("looksLintPragmaAdded: flags ruff/flake8/eslint/ts suppression pragmas", () => {
  const before = ["x = 1"].join("\n");
  assert.equal(looksLintPragmaAdded(before, ["# ruff: noqa: E501", "x = 1"].join("\n"), "app/x.py"), true);
  assert.equal(
    looksLintPragmaAdded(before, ["// eslint-disable-next-line no-console", "console.log(1)"].join("\n"), "src/x.ts"),
    true
  );
  assert.equal(looksLintPragmaAdded(before, ["// @ts-ignore", "const n: number = 1"].join("\n"), "src/x.ts"), true);
  assert.equal(looksLintPragmaAdded(before, ["# type: ignore", "n = 1"].join("\n"), "app/x.py"), true);
});

test("looksLintPragmaAdded: removing a pragma is allowed", () => {
  const before = ["# pylint: disable=duplicate-code", "def a():", "    return 1"].join("\n");
  const after = ["def a():", "    return 1"].join("\n");
  assert.equal(looksLintPragmaAdded(before, after, "app/x.py"), false);
});

test("looksLintPragmaAdded: a string literal quoting a pragma is not a pragma", () => {
  const before = ["x = 1"].join("\n");
  assert.equal(looksLintPragmaAdded(before, 'msg = "run with # noqa: E501 if needed"', "app/x.py"), false);
  assert.equal(looksLintPragmaAdded(before, 'log.info("eslint-disable applies here")', "src/x.ts"), false);
});

test("looksLintPragmaAdded: a docstring mentioning a pragma is not a pragma", () => {
  const before = ["x = 1"].join("\n");
  const after = ["def f():", '    """We dropped # pylint: disable last year."""', "    return 1"].join("\n");
  assert.equal(looksLintPragmaAdded(before, after, "app/x.py"), false);
});

test("looksLintPragmaAdded: prose that merely mentions 'disable' is not a pragma", () => {
  const before = ["def a():", "    return 1"].join("\n");
  const after = ["def a():", "    # disable the cache in tests", "    return 1"].join("\n");
  assert.equal(looksLintPragmaAdded(before, after, "app/x.py"), false);
});

test("looksLintPragmaAdded: a comment mentioning flake8= in prose is not a pragma", () => {
  const before = ["def a():", "    return 1"].join("\n");
  const after = ["def a():", "    # the flake8=: operator confuses people", "    return 1"].join("\n");
  assert.equal(looksLintPragmaAdded(before, after, "app/x.py"), false);
});
