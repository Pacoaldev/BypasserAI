import { test } from "node:test";
import assert from "node:assert/strict";
import { writeAuditEvent, readAuditEvents } from "../src/logger.js";
import type { AuditLogEvent } from "../src/logger.js";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withTmp(fn: (dir: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "bypasser-"));
  try {
    fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function event(over: Partial<AuditLogEvent> = {}): AuditLogEvent {
  return {
    ts: "2026-10-09 12:00:00",
    iso: "2026-10-09T12:00:00.000Z",
    provider: "localhost:20128",
    model: "zd/claude-sonnet-4-5",
    totalFiles: 1,
    rewrittenFiles: 0,
    rejectedFiles: 0,
    errorFiles: 0,
    files: [],
    ...over,
  };
}

test("audit-log: per-file fired signals round-trip through the JSONL", () => {
  withTmp((dir) => {
    writeAuditEvent(
      dir,
      event({
        files: [
          {
            path: "src/ai-slop.ts",
            score: 0.76,
            threshold: 0.65,
            status: "rejected",
            reason: "rewrite rejected (truncated)",
            signals: [
              { family: "naming", weight: 2.1 },
              { family: "comments", weight: 1.4 },
            ],
          },
        ],
      })
    );

    const events = readAuditEvents(dir);
    assert.equal(events.length, 1);
    const file = events[0].files[0];
    assert.equal(file.path, "src/ai-slop.ts");
    assert.deepEqual(file.signals, [
      { family: "naming", weight: 2.1 },
      { family: "comments", weight: 1.4 },
    ]);
  });
});

test("audit-log: events without signals stay valid (backward compatible)", () => {
  withTmp((dir) => {
    // Simulate a line written by an older BypasserAI that had no `signals` field.
    writeAuditEvent(
      dir,
      event({
        files: [{ path: "a.ts", score: 0.1, threshold: 0.65, status: "ok" }],
      })
    );

    const events = readAuditEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].files[0].signals, undefined);
    // The raw line must not contain an empty signals array garbage entry.
    const raw = readFileSync(join(dir, ".bypasser.log.jsonl"), "utf8");
    assert.ok(!/"signals":/u.test(raw));
  });
});

test("audit-log: corrupt line is skipped, later valid lines survive", () => {
  withTmp((dir) => {
    writeAuditEvent(dir, event({ totalFiles: 1 }));
    // A half-written trailing line (process killed mid-append).
    const path = join(dir, ".bypasser.log.jsonl");
    appendFileSync(path, "{ broken half-line", "utf8");

    const events = readAuditEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].totalFiles, 1);
  });
});
