import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAI,
  extractAddedLines,
  countChangedLines,
  isTypeScriptPath,
} from "../src/detector.js";

test("detectAI: clean human-looking code scores low", () => {
  const code = [
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "const x = add(1, 2);",
    "console.log(x);",
  ].join("\n");
  const { score } = detectAI(code);
  assert.ok(score < 0.5, `expected < 0.5, got ${score}`);
});

test("detectAI: heavy AI patterns score higher", () => {
  const code = [
    "/**",
    " * Processes the user data and returns the result.",
    " */",
    "const processData = async (inputData) => {",
    "  try {",
    "    // This function validates the input data",
    "    const validatedInput = validateInput(inputData);",
    "    const transformedData = transformData(validatedInput);",
    "    return transformedData;",
    "  } catch (error) {",
    "    throw new Error(`Failed: ${error.message}`);",
    "  }",
    "};",
  ].join("\n");
  const { score } = detectAI(code);
  assert.ok(score > 0.4, `expected > 0.4, got ${score}`);
});

// --- Calibration guards -----------------------------------------------------
// These lock the score curve so a future weight tweak cannot silently push
// realistic AI code back below the default 0.65 threshold (the original bug:
// the old normalised formula capped around 0.45, so nothing ever got rewritten).

const REALISTIC_AI_TS = [
  "import { createClient } from './client';",
  "",
  "/**",
  " * Initializes the database connection.",
  " * @param url The connection URL.",
  " * @returns The database client.",
  " */",
  "export const initializeDatabase = async (url) => {",
  "  // Validate the input URL",
  "  if (!url) {",
  "    throw new Error('URL is required');",
  "  }",
  "  // Create the client",
  "  const client = await createClient(url);",
  "  return client;",
  "};",
  "",
  "/**",
  " * Fetches the user profile.",
  " */",
  "export const fetchUserProfile = async (userId) => {",
  "  if (!userId) {",
  "    return null;",
  "  }",
  "  const response = await fetch('/users/' + userId);",
  "  return response.json();",
  "};",
  "",
  "/**",
  " * Processes the user data.",
  " */",
  "export const processUserData = (data) => {",
  "  const result = Object.keys(data).map((key) => data[key]);",
  "  return result;",
  "};",
].join("\n");

test("detectAI: realistic AI code clears the default 0.65 threshold", () => {
  const { score } = detectAI(REALISTIC_AI_TS, "src/api.ts");
  assert.ok(
    score >= 0.65,
    `realistic AI code must be actionable, got ${(score * 100).toFixed(0)}%`
  );
});

test("detectAI: a lone weak signal does not flag clean code", () => {
  // Descriptive names + try/catch are good practice, not proof of AI authorship.
  const code = [
    "const firstName = 'Ada';",
    "const lastName = 'Lovelace';",
    "const fullName = firstName + ' ' + lastName;",
    "try {",
    "  console.log(fullName);",
    "} catch (error) {",
    "  console.error(error);",
    "}",
  ].join("\n");
  const { score } = detectAI(code, "src/name.ts");
  assert.ok(score < 0.5, `clean code must not be flagged, got ${(score * 100).toFixed(0)}%`);
});

test("detectAI: interface signal applies to .ts files even without the keyword", () => {
  const code = [
    "const a = 1;",
    "const b = 2;",
    "const c = 3;",
  ].join("\n");
  const withPath = detectAI(code, "src/api.ts");
  const withoutPath = detectAI(code);
  const ifaceFiredWith = withPath.signals.find(
    (s) => s.description.includes("Interface")
  );
  const ifaceFiredWithout = withoutPath.signals.find(
    (s) => s.description.includes("Interface")
  );
  assert.ok(ifaceFiredWith, "signal should exist");
  // applicable in .ts context, so it must be evaluated (not unconditionally false)
  assert.equal(typeof ifaceFiredWith!.fired, "boolean");
  assert.ok(ifaceFiredWithout);
});

// --- Regression: 0% false negatives on genuinely AI-generated files ---------
// Incident: files that were 100% AI-generated scored 0% in the pre-commit
// report, so they were never humanized. Root cause was twofold:
//   1. audit.ts scored only the ADDED diff lines, so an edit that touched a
//      handful of lines in a large AI file was scored on those few lines.
//   2. detectAI() forces score=0 when total fired weight < 0.6, so a file that
//      fired a single strong signal (e.g. over-descriptive names, weight 0.9)
//      still reported a flat 0%.
// These tests lock that a file with real AI signals never reports exactly 0.

test("detectAI: over-descriptive naming alone yields a non-zero score", () => {
  const code = [
    "function processData(input) {",
    "  return handleResult(transformData(input));",
    "}",
    "function handleResult(value) {",
    "  return performOperation(value);",
    "}",
    "function performOperation(value) {",
    "  return validateInput(value);",
    "}",
  ].join("\n");
  const { score } = detectAI(code, "src/util.ts");
  assert.ok(score > 0, `AI naming must not score 0%, got ${(score * 100).toFixed(0)}%`);
});

test("detectAI: correlated weak signals are not zeroed out by the min-weight gate", () => {
  // Regression: the real `src/installer.ts` (277 lines, 100% AI-generated)
  // reported 0%. It fires only the weak "fully descriptive identifiers"
  // naming signal (weight 0.4), which was below the old MIN_FIRED_WEIGHT (0.6),
  // so the score was forced to a literal 0 — the worst possible output, since
  // 0% reads as "no AI here". A single weak signal may not be proof on its own,
  // but the gate must not erase a genuine signal.
  const code = [
    "import { resolve } from 'path';",
    "import { existsSync, writeFileSync } from 'fs';",
    "",
    "export function install(cwd = process.cwd()) {",
    "  const hookDirectory = resolve(cwd, '.git', 'hooks');",
    "  const hookPath = resolve(hookDirectory, 'pre-commit');",
    "  const vbsPath = resolve(hookDirectory, 'pre-commit-runner.vbs');",
    "  if (!existsSync(hookDirectory)) {",
    "    throw new Error('No .git/hooks directory found.');",
    "  }",
    "  writeFileSync(hookPath, buildHookScript(), 'utf8');",
    "  writeFileSync(vbsPath, buildVbsRunner(), 'utf8');",
    "}",
    "",
    "export function uninstall(cwd = process.cwd()) {",
    "  const hookDirectory = resolve(cwd, '.git', 'hooks');",
    "  const hookPath = resolve(hookDirectory, 'pre-commit');",
    "  const vbsPath = resolve(hookDirectory, 'pre-commit-runner.vbs');",
    "  if (!existsSync(hookPath)) {",
    "    return;",
    "  }",
    "  removeIfBypasserOwned(hookPath);",
    "  removeIfBypasserOwned(vbsPath);",
    "}",
  ].join("\n");
  const { score } = detectAI(code, "src/installer.ts");
  assert.ok(
    score > 0,
    `a file with real AI signals must not report a flat 0%, got ${(score * 100).toFixed(0)}%`
  );
});

test("detectAI: a large AI-style file never reports a flat 0%", () => {
  // Mirrors the shape that scored 0% in the wild: many uniform functions with
  // JSDoc, guards and descriptive names.
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push("/**");
    lines.push(` * Handles the request number ${i}.`);
    lines.push(" */");
    lines.push(`export const handleRequest${i} = async (inputData) => {`);
    lines.push("  if (!inputData) {");
    lines.push("    return null;");
    lines.push("  }");
    lines.push("  const processedData = transformData(inputData);");
    lines.push("  return processedData;");
    lines.push("};");
    lines.push("");
  }
  const { score } = detectAI(lines.join("\n"), "src/handlers.ts");
  assert.ok(score > 0, `large AI file must not score 0%, got ${(score * 100).toFixed(0)}%`);
  assert.ok(score >= 0.65, `large AI file should clear threshold, got ${(score * 100).toFixed(0)}%`);
});

// --- Calibration: real-world idiomatic AI files ------------------------------
// The signals were originally written against toy snippets and 8 of 13 never
// fired on real code. These fixtures use idiomatic `export async function`,
// JSDoc-on-most-functions and narrated comments — the exact shape of the real
// 100%-AI files in this repo — and must clear the threshold.

const REAL_IDIOMATIC_AI = [
  "import { execFileSync } from 'child_process';",
  "import { resolve } from 'path';",
  "",
  "/**",
  " * Runs a git command and returns its stdout.",
  " * Uses an argv array to avoid shell quoting issues.",
  " */",
  "function git(args, cwd) {",
  "  return execFileSync('git', args, { cwd, encoding: 'utf8' });",
  "}",
  "",
  "/**",
  " * Reads the staged files from the index.",
  " */",
  "export function getStagedFiles(cwd, config) {",
  "  const raw = git(['diff', '--cached', '--name-only'], cwd).trim();",
  "  if (!raw) return [];",
  "  const files = raw.split('\\n');",
  "  const result = [];",
  "  for (const filePath of files) {",
  "    // Read the staged version for this file",
  "    const content = git(['show', filePath], cwd);",
  "    result.push({ path: filePath, content });",
  "  }",
  "  return result;",
  "}",
  "",
  "/**",
  " * Builds a fake unified diff for an untracked file.",
  " */",
  "export function synthesizeAddedDiff(filePath, content) {",
  "  const body = content.split('\\n').map((line) => `+${line}`).join('\\n');",
  "  return `--- /dev/null\\n+++ b/${filePath}\\n${body}`;",
  "}",
  "",
  "/**",
  " * Returns the working-tree files that differ from HEAD.",
  " */",
  "export function getWorkingTreeFiles(cwd, config) {",
  "  const tracked = git(['diff', 'HEAD', '--name-only'], cwd);",
  "  const untracked = git(['ls-files', '--others'], cwd);",
  "  // Combine and de-duplicate the two lists",
  "  const paths = [...tracked.split('\\n'), ...untracked.split('\\n')];",
  "  return [...new Set(paths)].filter(Boolean);",
  "}",
].join("\n");

test("detectAI: idiomatic real-world AI file clears the threshold", () => {
  const { score } = detectAI(REAL_IDIOMATIC_AI, "src/git.ts");
  assert.ok(
    score >= 0.65,
    `idiomatic AI code must be actionable, got ${(score * 100).toFixed(0)}%`
  );
});

test("detectAI: hand-written terse code stays well below the threshold", () => {
  // A realistically messy human file: short names, mixed styles, sparse
  // comments, if/else, no JSDoc. Must NOT be flagged.
  const human = [
    "import { db } from './db';",
    "",
    "// fetch + cache",
    "const cache = new Map();",
    "",
    "async function getUser(id) {",
    "  if (cache.has(id)) {",
    "    return cache.get(id);",
    "  } else {",
    "    const r = await db.query(id);",
    "    if (r) cache.set(id, r);",
    "    return r;",
    "  }",
    "}",
    "",
    "function calc(items) {",
    "  let t = 0;",
    "  for (let i = 0; i < items.length; i++) {",
    "    t += items[i].v;",
    "  }",
    "  return t;",
    "}",
    "",
    "const x = getUser(1);",
    "const y = calc(arr);",
    "console.log(x, y);",
  ].join("\n");
  const { score } = detectAI(human, "src/data.ts");
  assert.ok(
    score < 0.5,
    `hand-written code must not be flagged, got ${(score * 100).toFixed(0)}%`
  );
});

test("isTypeScriptPath: detects ts/tsx/mts/cts only", () => {
  assert.equal(isTypeScriptPath("src/a.ts"), true);
  assert.equal(isTypeScriptPath("src/a.tsx"), true);
  assert.equal(isTypeScriptPath("src/a.mts"), true);
  assert.equal(isTypeScriptPath("src/a.cts"), true);
  assert.equal(isTypeScriptPath("src/a.js"), false);
  assert.equal(isTypeScriptPath("src/a.py"), false);
  assert.equal(isTypeScriptPath(undefined), false);
});

test("extractAddedLines: keeps only added lines, drops +++ header", () => {
  const diff = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,2 +1,3 @@",
    " context",
    "+added one",
    "-removed one",
    "+added two",
  ].join("\n");
  const added = extractAddedLines(diff);
  assert.equal(added, "added one\nadded two");
});

test("countChangedLines: counts added + removed, ignores headers", () => {
  const diff = [
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,2 +1,3 @@",
    " context",
    "+added one",
    "-removed one",
    "+added two",
  ].join("\n");
  assert.equal(countChangedLines(diff), 3);
});

test("countChangedLines: small diff is below the 5-line skip gate", () => {
  const diff = ["+++ b/f.ts", "+one", "+two"].join("\n");
  assert.ok(countChangedLines(diff) < 5);
});
