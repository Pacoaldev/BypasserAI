import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// `disable` — the hook's own source repo (and any repo that ships its own
// equivalent workflow) must be able to switch the audit off entirely with a
// per-project `.bypasser.json` flag. The pre-commit hook stays installed but is
// a no-op there. Hermetic: reads a real .bypasser.json from a temp dir.
// ---------------------------------------------------------------------------

function withConfig(json: unknown, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bypasser-disable-"));
  try {
    writeFileSync(join(dir, ".bypasser.json"), JSON.stringify(json), "utf8");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadConfig: disable defaults to false", () => {
  withConfig({}, (dir) => {
    assert.equal(loadConfig(dir).disable, false);
  });
});

test("loadConfig: disable: true is honoured from the project config", () => {
  withConfig({ disable: true }, (dir) => {
    assert.equal(loadConfig(dir).disable, true);
  });
});

test("loadConfig: disable: false is honoured", () => {
  withConfig({ disable: false }, (dir) => {
    assert.equal(loadConfig(dir).disable, false);
  });
});

test("loadConfig: BYPASSER_DISABLE env forces disable on regardless of the file", () => {
  withConfig({ disable: false }, (dir) => {
    const prev = process.env.BYPASSER_DISABLE;
    process.env.BYPASSER_DISABLE = "1";
    try {
      assert.equal(loadConfig(dir).disable, true);
    } finally {
      if (prev === undefined) delete process.env.BYPASSER_DISABLE;
      else process.env.BYPASSER_DISABLE = prev;
    }
  });
});
