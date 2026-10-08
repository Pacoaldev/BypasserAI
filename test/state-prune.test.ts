import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pruneState,
  recordRewriteInMemory,
  recordDetectionInMemory,
  cachedDetectionScore,
  loadBypasserState,
  saveBypasserState,
} from "../src/logger.js";
import type { BypasserState } from "../src/logger.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function emptyState(): BypasserState {
  return { rewrites: {}, detections: {} };
}

test("state: in-memory recording mutates without writing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bypasser-"));
  try {
    const state = emptyState();
    recordRewriteInMemory(state, "a.ts", "hash-a");
    recordDetectionInMemory(state, "b.ts", "hash-b", 0.9);
    // The object is updated...
    assert.equal(state.rewrites["a.ts"], "hash-a");
    assert.equal(state.detections["b.ts"].score, 0.9);
    // ...but nothing was persisted (no state file exists yet).
    const loaded = loadBypasserState(tmp);
    assert.deepEqual(loaded, emptyState());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("state: saveBypasserState persists the batch once", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bypasser-"));
  try {
    const state = emptyState();
    recordRewriteInMemory(state, "a.ts", "ha");
    recordRewriteInMemory(state, "b.ts", "hb");
    saveBypasserState(tmp, state);
    const loaded = loadBypasserState(tmp);
    assert.equal(loaded.rewrites["a.ts"], "ha");
    assert.equal(loaded.rewrites["b.ts"], "hb");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("state: cachedDetectionScore matches only on identical hash", () => {
  const state = emptyState();
  recordDetectionInMemory(state, "a.ts", "h1", 0.8);
  assert.equal(cachedDetectionScore(state, "a.ts", "h1"), 0.8);
  assert.equal(cachedDetectionScore(state, "a.ts", "different"), undefined);
  assert.equal(cachedDetectionScore(state, "missing.ts", "h1"), undefined);
});

test("pruneState: drops entries for deleted files", () => {
  const state = emptyState();
  recordRewriteInMemory(state, "kept.ts", "h");
  recordRewriteInMemory(state, "deleted.ts", "h");
  recordDetectionInMemory(state, "also-gone.ts", "h", 0.5);
  const { state: pruned, removed } = pruneState(state, ["kept.ts"]);
  assert.equal(removed, 2);
  assert.ok("kept.ts" in pruned.rewrites);
  assert.ok(!("deleted.ts" in pruned.rewrites));
  assert.ok(!("also-gone.ts" in pruned.detections));
});

test("pruneState: null liveFiles skips pruning entirely", () => {
  const state = emptyState();
  recordRewriteInMemory(state, "a.ts", "h");
  const { state: pruned, removed } = pruneState(state, null);
  assert.equal(removed, 0);
  assert.ok("a.ts" in pruned.rewrites);
});

test("pruneState: nothing removed when all files are live", () => {
  const state = emptyState();
  recordRewriteInMemory(state, "a.ts", "h");
  recordDetectionInMemory(state, "b.ts", "h", 0.4);
  const { removed } = pruneState(state, ["a.ts", "b.ts"]);
  assert.equal(removed, 0);
});

test("state: a corrupt state file degrades to an empty state", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bypasser-"));
  try {
    writeFileSync(join(tmp, ".bypasser.state.json"), "{ not json", "utf8");
    assert.deepEqual(loadBypasserState(tmp), emptyState());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
