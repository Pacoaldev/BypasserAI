import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGlob, shouldIgnore } from "../src/git.js";
import { resolveThreshold, type BypasserConfig } from "../src/config.js";

test("matchGlob: * matches within a path segment", () => {
  assert.equal(matchGlob("src/index.ts", "*.ts"), true);
  assert.equal(matchGlob("src/nested/index.ts", "*.ts"), true);
  assert.equal(matchGlob("src/index.js", "*.ts"), false);
});

test("matchGlob: ** matches across segments", () => {
  assert.equal(matchGlob("dist/a/b/c.js", "dist/**"), true);
  assert.equal(matchGlob("build/x.js", "dist/**"), false);
});

test("matchGlob: exact filename", () => {
  assert.equal(matchGlob("package-lock.json", "package-lock.json"), true);
  assert.equal(matchGlob("deep/pkg/package-lock.json", "package-lock.json"), true);
});

test("shouldIgnore: respects custom patterns on top of built-ins", () => {
  assert.equal(shouldIgnore("src/gen/schema.ts", ["src/gen/**"]), true);
  assert.equal(shouldIgnore("src/index.ts", ["src/gen/**"]), false);
});

function baseConfig(overrides: Partial<BypasserConfig> = {}): BypasserConfig {
  return {
    baseURL: "x",
    apiKey: "x",
    model: "x",
    threshold: 0.65,
    maxTokens: 1,
    temperature: 0.4,
    ignore: [],
    thresholds: [],
    ...overrides,
  };
}

test("resolveThreshold: falls back to global threshold", () => {
  const cfg = baseConfig();
  assert.equal(resolveThreshold("src/a.ts", cfg, matchGlob), 0.65);
});

test("resolveThreshold: first matching per-glob rule wins", () => {
  const cfg = baseConfig({
    thresholds: [
      { pattern: "src/legacy/**", value: 0.3 },
      { pattern: "*.ts", value: 0.5 },
    ],
  });
  assert.equal(resolveThreshold("src/legacy/a.ts", cfg, matchGlob), 0.3);
  assert.equal(resolveThreshold("src/a.ts", cfg, matchGlob), 0.5);
  assert.equal(resolveThreshold("src/a.py", cfg, matchGlob), 0.65);
});
