import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveRewriteScope, loadConfig } from "../src/config.js";

test("resolveEffectiveRewriteScope picks diff for large file with small edit", () => {
  const config = loadConfig("/nonexistent");
  const scope = resolveEffectiveRewriteScope(config, {
    lineCount: 2500,
    changedLines: 40,
    addedFraction: 0.02,
  });
  assert.equal(scope, "diff");
});

test("resolveEffectiveRewriteScope picks chunk for mostly-new large file", () => {
  const config = loadConfig("/nonexistent");
  const scope = resolveEffectiveRewriteScope(config, {
    lineCount: 2500,
    changedLines: 2400,
    addedFraction: 0.85,
  });
  assert.equal(scope, "chunk");
});

test("resolveEffectiveRewriteScope picks file for small files", () => {
  const config = loadConfig("/nonexistent");
  const scope = resolveEffectiveRewriteScope(config, {
    lineCount: 120,
    changedLines: 80,
    addedFraction: 0.5,
  });
  assert.equal(scope, "file");
});
