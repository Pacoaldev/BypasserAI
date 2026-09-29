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
    (s) => s.description.includes("Interface defined")
  );
  const ifaceFiredWithout = withoutPath.signals.find(
    (s) => s.description.includes("Interface defined")
  );
  assert.ok(ifaceFiredWith, "signal should exist");
  // applicable in .ts context, so it must be evaluated (not unconditionally false)
  assert.equal(typeof ifaceFiredWith!.fired, "boolean");
  assert.ok(ifaceFiredWithout);
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
