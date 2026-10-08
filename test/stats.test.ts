import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, bucketReason, renderStats } from "../src/stats.js";
import { providerHost, auditFileStatus } from "../src/audit.js";
import type { AuditLogEvent } from "../src/logger.js";

function event(over: Partial<AuditLogEvent>): AuditLogEvent {
  return {
    ts: "2026-01-01 00:00:00",
    iso: "2026-01-01T00:00:00.000Z",
    provider: "api.openai.com",
    model: "gpt-4o-mini",
    totalFiles: 1,
    rewrittenFiles: 0,
    rejectedFiles: 0,
    errorFiles: 0,
    files: [],
    ...over,
  };
}

test("stats: empty history renders a friendly message", () => {
  const s = computeStats([]);
  assert.equal(s.runs, 0);
  assert.match(renderStats(s), /No structured audit history/);
});

test("stats: success rate is rewritten / attempts", () => {
  const s = computeStats([
    event({ rewrittenFiles: 2, rejectedFiles: 1, errorFiles: 1 }),
  ]);
  assert.equal(s.rewrittenFiles, 2);
  assert.equal(s.rejectedFiles, 1);
  assert.equal(s.errorFiles, 1);
  assert.equal(s.successRate, 0.5);
});

test("stats: flagged files are counted across runs", () => {
  const s = computeStats([
    event({ files: [{ path: "a.ts", score: 0.9, threshold: 0.65, status: "rewritten" }] }),
    event({ files: [{ path: "a.ts", score: 0.8, threshold: 0.65, status: "rejected" }] }),
  ]);
  assert.equal(s.flaggedFiles, 1);
  assert.equal(s.hotspots[0].path, "a.ts");
  assert.equal(s.hotspots[0].unresolved, 1);
  assert.equal(s.hotspots[0].flagged, 2);
});

test("stats: clean files are not hotspots", () => {
  const s = computeStats([
    event({ files: [{ path: "clean.ts", score: 0.2, threshold: 0.65, status: "ok" }] }),
  ]);
  assert.equal(s.flaggedFiles, 0);
  assert.deepEqual(s.hotspots, []);
});

test("stats: groups by provider/model", () => {
  const s = computeStats([
    event({ provider: "api.openai.com", model: "m1", rewrittenFiles: 3 }),
    event({ provider: "localhost:11434", model: "llama", errorFiles: 2 }),
  ]);
  assert.equal(s.providers.length, 2);
  const openai = s.providers.find((p) => p.provider === "api.openai.com");
  assert.equal(openai?.rewrittenFiles, 3);
  assert.equal(openai?.successRate, 1);
});

test("stats: rejection reasons are bucketed", () => {
  const s = computeStats([
    event({
      files: [
        { path: "x.ts", score: 0.9, threshold: 0.65, status: "rejected", reason: "rewrite rejected (truncated)" },
        { path: "y.ts", score: 0.9, threshold: 0.65, status: "rejected", reason: "rewrite rejected (truncated)" },
        { path: "z.ts", score: 0.9, threshold: 0.65, status: "rejected", reason: "rewrite rejected (indent)" },
      ],
    }),
  ]);
  assert.equal(s.rejectionReasons.truncated, 2);
  assert.equal(s.rejectionReasons.indent, 1);
});

test("bucketReason: maps known shapes", () => {
  assert.equal(bucketReason("rewrite error: 500"), "api-error");
  assert.equal(bucketReason("rewrite rejected (syntax)"), "syntax");
  assert.equal(bucketReason("already humanized (unchanged)"), "unchanged");
  assert.equal(bucketReason("too few changed lines"), "too-few-lines");
  assert.equal(bucketReason("file too large (5000 lines)"), "too-large");
  assert.equal(bucketReason(undefined), "unknown");
});

test("providerHost: reduces a URL to its host without leaking paths", () => {
  assert.equal(providerHost("https://api.openai.com/v1"), "api.openai.com");
  assert.equal(providerHost("http://localhost:20128/v1"), "localhost:20128");
  // A key smuggled into the URL path must NOT survive into the log.
  assert.equal(providerHost("https://host/v1/sk-secret"), "host");
  assert.equal(providerHost("not-a-url"), "not-a-url");
});

test("auditFileStatus: classifies each file outcome", () => {
  const base = { path: "a", score: 0.9, threshold: 0.65, signals: [], rewritten: false };
  assert.equal(auditFileStatus({ ...base, rewritten: true }), "rewritten");
  assert.equal(auditFileStatus({ ...base, skippedReason: "rewrite error: x" }), "error");
  assert.equal(auditFileStatus({ ...base, skippedReason: "rewrite rejected (truncated)" }), "rejected");
  assert.equal(auditFileStatus({ ...base, skippedReason: "too few changed lines" }), "skipped");
  assert.equal(auditFileStatus(base), "unresolved");
  assert.equal(auditFileStatus({ ...base, score: 0.2 }), "ok");
});

test("stats: renderStats includes the headline numbers", () => {
  const out = renderStats(
    computeStats([event({ totalFiles: 5, rewrittenFiles: 2, rejectedFiles: 1 })])
  );
  assert.match(out, /files scanned\s+: 5/);
  assert.match(out, /humanized\s+: 2/);
  assert.match(out, /api\.openai\.com\/gpt-4o-mini/);
});
