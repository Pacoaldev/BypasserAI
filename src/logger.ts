import { appendFileSync, writeFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";

const LOG_FILE = ".bypasser.log";
const JSONL_FILE = ".bypasser.log.jsonl";
const STATE_FILE = ".bypasser.state.json";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function writeLog(cwd: string, lines: string[]): void {
  const logPath = resolve(cwd, LOG_FILE);
  const header = `\n── ${timestamp()} ─────────────────────────────────────`;
  const block = [header, ...lines, ""].join("\n");

  try {
    if (!existsSync(logPath)) {
      writeFileSync(logPath, "# bypasser-ai — commit scan log\n", "utf8");
    }
    appendFileSync(logPath, block, "utf8");
  } catch {
    // never block commit on log write failure
  }
}

// ---------------------------------------------------------------------------
// Structured audit log (JSONL) — consumed by `bypasser stats`
// ---------------------------------------------------------------------------

/**
 * One audit event, written as a single JSON line to `.bypasser.log.jsonl`.
 * Flat and append-only so `bypasser stats` can aggregate without a database.
 * Half-written line only loses the last event.
 */
export interface AuditLogEvent {
  ts: string;
  /** ISO timestamp (machine-sortable; `ts` is human form). */
  iso: string;
  /** Host of configured baseURL, e.g. `api.openai.com` — never the key. */
  provider: string;
  model: string;
  totalFiles: number;
  rewrittenFiles: number;
  rejectedFiles: number;
  errorFiles: number;
  files: Array<{
    path: string;
    score: number;
    threshold: number;
    /** `ok` | `rewritten` | `skipped` | `rejected` | `error` */
    status: string;
    /** Free-text detail for skipped/rejected/error. */
    reason?: string;
    /**
     * Per-family detector signals that fired for this file, e.g.
     * `[{ family: "naming", weight: 2.1 }]`. Optional and additive: events
     * written before this field existed simply omit it, and consumers
     * (`bypasser stats`, the OpenCode panel) must tolerate its absence.
     * Only signals with `fired: true` are persisted, to keep the sidecar small.
     */
    signals?: Array<{
      family: string;
      weight: number;
    }>;
  }>;
}

/** Append structured audit event to `.bypasser.log.jsonl`. Best-effort. */
export function writeAuditEvent(cwd: string, event: AuditLogEvent): void {
  const path = resolve(cwd, JSONL_FILE);
  try {
    appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // never block commit on log write failure
  }
}

/** Read and parse every valid JSONL event, skip malformed lines. */
export function readAuditEvents(cwd: string): AuditLogEvent[] {
  const path = resolve(cwd, JSONL_FILE);
  if (!existsSync(path)) return [];
  const events: AuditLogEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditLogEvent;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.files)) {
        events.push(parsed);
      }
    } catch {
      // skip corrupt/half-written line, keep rest
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Rewrite + detection state
//
// ## Write batching
//
// State is a single small JSON document. Original API (`recordRewrite` /
// `recordDetection`) rewrote WHOLE file on every call, so audit over N staged
// files performed N full synchronous writes — O(N·size) I/O in pre-commit hook
// that's already latency-sensitive. `*InMemory` variants mutate object only;
// `runAudit` calls `saveBypasserState` once at end. Old write-through helpers
// remain for external callers/tests but hot path no longer uses them.
// ---------------------------------------------------------------------------

export interface DetectionCacheEntry {
  contentHash: string;
  score: number;
}

export interface BypasserState {
  rewrites: Record<string, string>;
  detections: Record<string, DetectionCacheEntry>;
}

function emptyState(): BypasserState {
  return { rewrites: {}, detections: {} };
}

function normalizeState(raw: unknown): BypasserState {
  if (!raw || typeof raw !== "object") return emptyState();
  const obj = raw as Record<string, unknown>;
  if ("rewrites" in obj || "detections" in obj) {
    return {
      rewrites: (obj.rewrites as Record<string, string>) ?? {},
      detections: (obj.detections as Record<string, DetectionCacheEntry>) ?? {},
    };
  }
  // Legacy flat map: path -> rewrite hash only
  return { rewrites: obj as Record<string, string>, detections: {} };
}

export function loadBypasserState(cwd: string): BypasserState {
  const statePath = resolve(cwd, STATE_FILE);
  if (!existsSync(statePath)) return emptyState();
  try {
    return normalizeState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    return emptyState();
  }
}

/** @deprecated use loadBypasserState */
export function loadRewriteState(cwd: string): Record<string, string> {
  return loadBypasserState(cwd).rewrites;
}

export function saveBypasserState(cwd: string, state: BypasserState): void {
  const statePath = resolve(cwd, STATE_FILE);
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // non-fatal
  }
}

/**
 * Record successful rewrite **in memory only**. Call `saveBypasserState` once
 * when audit finishes to persist. Use legacy `recordRewrite` (which writes
 * through) only outside hot path.
 */
export function recordRewriteInMemory(
  state: BypasserState,
  filePath: string,
  hash: string
): BypasserState {
  state.rewrites[filePath] = hash;
  return state;
}

/** Record detection score **in memory only**. See `recordRewriteInMemory`. */
export function recordDetectionInMemory(
  state: BypasserState,
  filePath: string,
  contentHash: string,
  score: number
): BypasserState {
  state.detections[filePath] = { contentHash, score };
  return state;
}

/** @deprecated writes through on every call — prefer InMemory variants. */
export function recordRewrite(
  cwd: string,
  filePath: string,
  hash: string,
  state?: BypasserState
): BypasserState {
  const s = state ?? loadBypasserState(cwd);
  recordRewriteInMemory(s, filePath, hash);
  saveBypasserState(cwd, s);
  return s;
}

/** @deprecated writes through on every call — prefer InMemory variants. */
export function recordDetection(
  cwd: string,
  filePath: string,
  contentHash: string,
  score: number,
  state?: BypasserState
): BypasserState {
  const s = state ?? loadBypasserState(cwd);
  recordDetectionInMemory(s, filePath, contentHash, score);
  saveBypasserState(cwd, s);
  return s;
}

export function cachedDetectionScore(
  state: BypasserState,
  filePath: string,
  contentHash: string
): number | undefined {
  const entry = state.detections[filePath];
  if (entry && entry.contentHash === contentHash) return entry.score;
  return undefined;
}

/**
 * Drop state entries for paths that no longer exist in working set, keep
 * sidecar from growing without bound as files are deleted or renamed.
 *
 * `liveFiles` is full set of paths repo still tracks (as returned by git), so
 * state never prunes entry whose file simply wasn't part of this commit. When
 * `liveFiles` is `null` pruning is skipped entirely — callers that can't
 * enumerate repo must not silently wipe cache.
 */
export function pruneState(
  state: BypasserState,
  liveFiles: Iterable<string> | null
): { state: BypasserState; removed: number } {
  if (liveFiles === null) return { state, removed: 0 };
  const live = new Set(liveFiles);
  let removed = 0;
  for (const path of Object.keys(state.rewrites)) {
    if (!live.has(path)) {
      delete state.rewrites[path];
      removed++;
    }
  }
  for (const path of Object.keys(state.detections)) {
    if (!live.has(path)) {
      delete state.detections[path];
      removed++;
    }
  }
  return { state, removed };
}