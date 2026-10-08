import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSource } from "../src/mask.js";
import { resolveLanguage, detectAI } from "../src/detector.js";

/**
 * Masking guards.
 *
 * These lock in the three classes of false positive/negative that the raw-text
 * detector used to produce: comment markers inside strings, comment markers
 * inside URLs, and regex-looking text inside strings/comments being counted as
 * real code.
 */

function mask(code: string, path: string) {
  return maskSource(code, resolveLanguage(path, code));
}

test("mask: a comment marker inside a string does not leak into the code view", () => {
  const code = 'const s = "// Validate input";\nconst t = 1;';
  const { code: codeView } = mask(code, "a.ts");
  assert.ok(!codeView.includes("Validate"), "string content must be blanked in the code view");
  assert.ok(codeView.includes("const"), "real code must survive");
});

test("mask: a URL literal does not read as a comment", () => {
  const code = 'const url = "https://api.example.com/v1";\nreturn url;';
  const { comments } = mask(code, "a.ts");
  assert.equal(comments.trim(), "", "a // inside a string is not a comment");
});

test("mask: function keyword inside a string is not counted as a function", () => {
  const code = [
    'const re = "function foo() {}";',
    'const doc = `export function bar() {}`;',
    "const x = 1;",
  ].join("\n");
  const { code: codeView } = mask(code, "a.ts");
  assert.ok(!codeView.includes("function"), "function keyword inside a string must be blanked");
});

test("mask: JS regex literals with keywords are masked (Nivel B)", () => {
  // A `/function/` regex literal must not be read as a real declaration. The
  // masker uses the standard lexer heuristic (a `/` after an identifier or an
  // expression-ending token is division, otherwise a regex).
  const code = "const m = path.match(/function\\s+bar/);";
  const { code: codeView } = mask(code, "a.ts");
  assert.ok(!codeView.includes("function"), "regex literal content must be blanked");
});

test("mask: a division is NOT mistaken for a regex start", () => {
  const code = "const ratio = total / count;\nconst x = 1;";
  const { code: codeView } = mask(code, "a.ts");
  // Everything after `= total / count;` must survive (no runaway regex swallow).
  assert.ok(codeView.includes("count"), "division must not blank the rest of the line");
  assert.ok(codeView.includes("const x = 1"));
});

test("mask: regex char class containing a slash does not end early", () => {
  const code = "const r = /[/]function/g;\nconst y = 2;";
  const { code: codeView } = mask(code, "a.ts");
  assert.ok(codeView.includes("const y = 2"), "the regex must be fully consumed");
  assert.ok(!codeView.includes("function"));
});

test("mask: Python f-string and prefixed strings are masked", () => {
  const code = ['x = f"function foo {bar}"', 'y = r"def baz"', "z = 1"].join("\n");
  const { code: codeView } = mask(code, "a.py");
  assert.ok(!codeView.includes("function"), "f-string content must be blanked");
  assert.ok(!codeView.includes("def baz"), "raw string content must be blanked");
  assert.ok(codeView.includes("z = 1"));
});

test("mask: Python triple-quoted f-string is fully masked in the code view", () => {
  const code = ['s = f"""', "export function fake() {}", '"""', "t = 2"].join("\n");
  const { code: codeView } = mask(code, "a.py");
  assert.ok(!codeView.includes("export function"), "triple f-string body must be blanked");
  assert.ok(codeView.includes("t = 2"));
});

test("mask: Rust raw strings are masked", () => {
  const code = ['let s = r#"fn fake() {}"#;', "let t = 2;"].join("\n");
  const { code: codeView } = mask(code, "a.rs");
  assert.ok(!codeView.includes("fn fake"), "raw string content must be blanked");
  assert.ok(codeView.includes("let t = 2"));
});

test("mask: real comments land in the comments view, code does not", () => {
  const code = ["// Validate the input", "const x = validate(y);"].join("\n");
  const { comments, code: codeView } = mask(code, "a.ts");
  assert.ok(comments.includes("Validate the input"));
  assert.ok(!comments.includes("validate(y)"), "code must not leak into the comment view");
  assert.ok(codeView.includes("validate(y)"));
  assert.ok(!codeView.includes("Validate the input"));
});

test("mask: block comments are captured and blanked", () => {
  const code = ["/* Create the client */", "const c = connect();"].join("\n");
  const { comments, code: codeView } = mask(code, "a.ts");
  assert.ok(comments.includes("Create the client"));
  assert.ok(!codeView.includes("Create the client"));
});

test("mask: Python docstrings survive in the documented view but not the code view", () => {
  const code = ['def f():', '    """Fetch the user."""', "    return 1"].join("\n");
  const { documented, code: codeView } = mask(code, "a.py");
  assert.ok(documented.includes("Fetch the user"), "docstring must remain documented");
  assert.ok(!codeView.includes("Fetch the user"), "docstring body must not scan as code");
});

test("mask: Python # comment is a comment, not code", () => {
  const code = ["# note: .get()/.post()", "x = 1"].join("\n");
  const { comments, code: codeView } = mask(code, "a.py");
  assert.ok(comments.includes("note:"));
  assert.ok(!codeView.includes("note:"));
});

test("detect: a string mentioning AI keywords does not inflate the score", () => {
  // The raw-text detector counted `"processData"` / narrated-looking strings
  // and pushed clean code over the threshold. With masking it must stay low.
  const clean = [
    "const label = 'processData validateInput transformData';",
    "const hint = '// This function processes the user data';",
    "const url = 'https://api.example.com/fetch';",
    "function run() { return label + hint + url; }",
  ].join("\n");
  const { score } = detectAI(clean, "src/labels.ts");
  assert.ok(score < 0.5, `string contents must not inflate score, got ${(score * 100).toFixed(0)}%`);
});
