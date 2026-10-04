import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUnbalancedBrackets } from "../src/bracket-balance.js";
import { resolveLanguage } from "../src/detector.js";
import { looksTruncated, sanitizeResponse } from "../src/rewriter.js";

// ---------------------------------------------------------------------------
// Regression suite for the "it always uploads the original" incident.
//
// Incident: committing `src/utils.py` (≈1600 lines, 74% AI score) in BUSCAPISPro
// was rejected at EVERY scope — full-file ("unbalanced brackets: 236 vs 235
// lines"), diff hunk ("Hunk 646-880 rejected"), and chunk assembly ("unbalanced
// brackets after chunk assembly: 1809 vs 1809 lines"). The original slop was
// committed, defeating the whole tool.
//
// Root cause: `hasUnbalancedBrackets` was a C-style-only scan. It knew `//`
// comments but NOT `#`. Python files are full of `#` comments whose text
// contains brackets — `# concurrent .get()/.post() ...`, `# ... (UUID ...) ...`
// — and every such comment leaked brackets into the stack, so the file *always*
// looked cut off. The humanizer's output keeps (some) comments, so it was
// rejected too, and the fallback `isSafePartialHumanization` shared the same
// broken check. Result: nothing was ever humanized.
//
// These tests pin the language-aware scanner so a valid Python/Ruby file can
// never be rejected as "unbalanced" again — while a genuinely truncated file is
// still caught.
// ---------------------------------------------------------------------------

function bal(code: string, path: string): boolean {
  return hasUnbalancedBrackets(code, resolveLanguage(path, code));
}

test("balance: Python comment with an unpaired paren is NOT unbalanced", () => {
  const code = ["x = 1", "# concurrent .get()/.post() across threads is safe", 'msg = "ok"'].join("\n");
  assert.equal(bal(code, "src/utils.py"), false);
});

test("balance: Python comment with an unpaired brace is NOT unbalanced", () => {
  const code = ["# { this brace never closes in the comment", "x = 1"].join("\n");
  assert.equal(bal(code, "src/utils.py"), false);
});

test("balance: Python comment with an unpaired bracket is NOT unbalanced", () => {
  const code = ["# see [docs for details", "def f():", "    return 1"].join("\n");
  assert.equal(bal(code, "src/utils.py"), false);
});

test("balance: Python docstring containing brackets is NOT unbalanced", () => {
  const code = ['"""Config (temporary) {not a real brace}.', 'Args:', '    value: dict[str, int]', '"""', "def f():", "    return 1"].join("\n");
  assert.equal(bal(code, "src/utils.py"), false);
});

test("balance: Python single-quoted triple docstring is NOT unbalanced", () => {
  const code = ["'''doc ( with paren { and brace'''", "x = 1"].join("\n");
  assert.equal(bal(code, "src/utils.py"), false);
});

test("balance: Python f-string placeholders are NOT unbalanced", () => {
  const code = ['line = f"{key} and {value + 1}"', "x = 1"].join("\n");
  assert.equal(bal(code, "src/utils.py"), false);
});

test("balance: a real Python file with many commented brackets is balanced", () => {
  // Mirrors real buscapispro/src/utils.py: comments full of .get()/.post()/(...).
  const code = [
    "# OpenAI-compatible providers: prefer a 1-token chat probe (stricter than GET /models).",
    "# FastRouter: GET /v1/models is public (200 sin clave); auth real en /chat/completions.",
    "# DeepSeek: sk- + 32 hex (UUID sin guiones) o prefijo legacy sk-deepseek-",
    "# avoids a fresh TCP+TLS handshake per probe (~100-300ms each). httpx's sync",
    "# concurrent .get()/.post() across threads is safe (same model as requests').",
    "",
    'def resolve_key(key: str) -> str:',
    '    return key.strip()',
  ].join("\n");
  assert.equal(bal(code, "src/utils.py"), false);
});

test("balance: Ruby comment with an unpaired paren is NOT unbalanced", () => {
  const code = ["x = 1", "# see (the docs", "puts x"].join("\n");
  assert.equal(bal(code, "app/main.rb"), false);
});

test("balance: a genuinely truncated Python file IS unbalanced", () => {
  const code = ["def f(x):", "    return (x + 1"].join("\n");
  assert.equal(bal(code, "src/utils.py"), true);
});

test("balance: a genuinely truncated JS file IS unbalanced", () => {
  const code = ["function f() {", "  return (1"].join("\n");
  assert.equal(bal(code, "src/x.ts"), true);
});

test("balance: brackets inside a JS string/comment are ignored", () => {
  const code = ["const x = 1;", "// note ( unbalanced in comment", 'const y = "(also unbalanced";'].join("\n");
  assert.equal(bal(code, "src/x.ts"), false);
});

test("balance: JS block comment brackets are ignored", () => {
  const code = ["/* (unclosed paren in a block comment", "   { also a brace */", "const x = 1;"].join("\n");
  assert.equal(bal(code, "src/x.ts"), false);
});

// ---------------------------------------------------------------------------
// End-to-end: the exact failure path. A realistic Python file whose comments
// carry brackets must survive sanitizeResponse (it must NOT be called truncated
// just because of a `#` comment), and looksTruncated must return false.
// ---------------------------------------------------------------------------

function pythonWithCommentedBrackets(): string {
  const lines: string[] = [];
  lines.push('"""Module (utility) docstring with { braces } and [brackets]."""');
  lines.push("import os");
  lines.push("");
  for (let i = 0; i < 30; i++) {
    lines.push(`# handler ${i}: calls .get() and .post() (see docs)`);
    lines.push(`def handler_${i}(value):`);
    lines.push(`    # return the value (unchanged)`);
    lines.push(`    return value`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

test("looksTruncated: a Python file with bracketed comments is NOT truncated", () => {
  const original = pythonWithCommentedBrackets();
  // A faithful humanizer rewrite: same code, comments lightly reworded (still
  // containing brackets). This is exactly what the model returns in the wild.
  const rewritten = original.replace(/handler_/g, "process_").replace(/value/g, "val");
  assert.equal(looksTruncated(rewritten, original, "stop", "src/utils.py"), false);
});

test("sanitizeResponse: a Python rewrite with bracketed comments is accepted", () => {
  const original = pythonWithCommentedBrackets();
  const rewritten = original.replace(/handler_/g, "process_").replace(/value/g, "val");
  const result = sanitizeResponse(rewritten, original, "src/utils.py", "stop");
  assert.equal(result.wasInvalid, false, "a valid Python rewrite must not be rejected as truncated");
  assert.equal(result.content, rewritten);
});

test("sanitizeResponse: a genuinely truncated Python rewrite is still rejected", () => {
  const original = pythonWithCommentedBrackets();
  // Cut the file mid-call → unbalanced brackets → must reject and keep original.
  const truncated = original.split("\n").slice(0, 40).join("\n") + "\ndef broken(\n";
  const result = sanitizeResponse(truncated, original, "src/utils.py", "length");
  assert.equal(result.wasInvalid, true);
  assert.equal(result.content, original);
});
