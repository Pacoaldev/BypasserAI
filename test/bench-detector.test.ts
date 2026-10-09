import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadCorpus,
  scoreCorpus,
  computeMetrics,
  buildSnapshot,
  readSnapshot,
  writeSnapshot,
  DEFAULT_THRESHOLD,
  SNAPSHOT_TOLERANCE,
} from "../scripts/bench-detector.js";

/**
 * Corpus benchmark + golden snapshot.
 *
 * What this locks in
 * ------------------
 * The score curve and the signal weights were originally tuned by hand, with
 * only a few "above/below 0.65" assertions guarding them. That made any weight
 * change invisible: a tweak could quietly drop a whole language below threshold
 * and the test suite would stay green.
 *
 * These tests:
 *   1. Run the detector over the annotated corpus and assert a **quality floor**
 *      (precision / recall / F1) — so a change that makes the detector worse in
 *      aggregate fails, not just an individual case.
 *   2. Compare every sample's score against a **golden snapshot**. A drift
 *      beyond `SNAPSHOT_TOLERANCE` fails, forcing the change to be
 *      acknowledged. To re-record after an intentional change:
 *
 *          BYPASSER_UPDATE_SNAPSHOT=1 npm test
 *          npm run bench -- --snapshot   # refresh the human-readable one too
 */

const UPDATE = process.env.BYPASSER_UPDATE_SNAPSHOT === "1";

test("bench: corpus has both AI and human samples across languages", () => {
  const corpus = loadCorpus();
  assert.ok(corpus.samples.length >= 6, "corpus must have a meaningful number of samples");
  const labels = new Set(corpus.samples.map((s) => s.label));
  assert.ok(labels.has("ai") && labels.has("human"), "corpus needs both classes");
  const langs = new Set(corpus.samples.map((s) => s.lang));
  assert.ok(langs.size >= 3, "corpus should span at least three languages");
});

test("bench: detector meets aggregate quality floor", () => {
  const metrics = computeMetrics(scoreCorpus(loadCorpus()));

  // These floors are the *current* baseline minus a safety margin. They are a
  // ratchet: raise them when the detector improves, never lower them to make a
  // regression pass.
  //
  // The service-fingerprint work (narration-transition + Go error-guard +
  // Ruby postfix-guard signals) brought the three known false negatives
  // (`ai-go-service`, `ai-csharp-controller`, `ai-ruby-service`) above the
  // default threshold, so the floors moved up to match: precision 100%,
  // recall 100%, F1 100%. Keep a small margin so an incidental drift in a
  // single sample does not fail CI on noise alone.
  assert.ok(
    metrics.recall >= 0.9,
    `recall regressed below floor: ${(metrics.recall * 100).toFixed(0)}% (need >= 90%)`
  );
  assert.ok(
    metrics.precision >= 0.9,
    `precision regressed below floor: ${(metrics.precision * 100).toFixed(0)}% (need >= 90%)`
  );
  assert.ok(
    metrics.f1 >= 0.9,
    `F1 regressed below floor: ${(metrics.f1 * 100).toFixed(0)}% (need >= 90%)`
  );
});

test("bench: no human sample is flagged as AI", () => {
  // False positives are the expensive mistake (they rewrite good human code),
  // so they get their own explicit guard independent of the aggregate F1.
  const scores = scoreCorpus(loadCorpus());
  for (const s of scores.filter((x) => x.label === "human")) {
    assert.ok(
      s.score < DEFAULT_THRESHOLD,
      `human sample "${s.id}" was flagged (${(s.score * 100).toFixed(0)}% >= ${DEFAULT_THRESHOLD})`
    );
  }
});

test("bench: golden snapshot matches current scores", () => {
  const scores = scoreCorpus(loadCorpus());
  const current = buildSnapshot(scores);
  const golden = readSnapshot();

  if (UPDATE || Object.keys(golden).length === 0) {
    writeSnapshot(scores);
    return;
  }

  for (const [id, expected] of Object.entries(golden)) {
    const actual = current[id];
    assert.ok(actual !== undefined, `sample "${id}" is in the snapshot but not the corpus`);
    assert.ok(
      Math.abs(actual - expected) <= SNAPSHOT_TOLERANCE,
      `score drift for "${id}": expected ${expected}, got ${actual} ` +
        `(tolerance ${SNAPSHOT_TOLERANCE}). If intentional, re-record with ` +
        `BYPASSER_UPDATE_SNAPSHOT=1 npm test`
    );
  }

  for (const id of Object.keys(current)) {
    assert.ok(id in golden, `new sample "${id}" is missing from the snapshot — re-record it`);
  }
});
