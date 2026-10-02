import { appendFileSync, writeFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";

const LOG_FILE = ".bypasser.log";
/** Sidecar store of successful rewrite hashes, keyed by file path. */
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
    // never block the commit because of a log write failure
  }
}

// ---------------------------------------------------------------------------
// Rewrite + detection state
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
  const o = raw as Record<string, unknown>;
  if ("rewrites" in o || "detections" in o) {
    return {
      rewrites: (o.rewrites as Record<string, string>) ?? {},
      detections: (o.detections as Record<string, DetectionCacheEntry>) ?? {},
    };
  }
  // Legacy flat map: path -> rewrite hash only
  return { rewrites: o as Record<string, string>, detections: {} };
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

export function recordRewrite(
  cwd: string,
  filePath: string,
  hash: string,
  state?: BypasserState
): BypasserState {
  const next = state ?? loadBypasserState(cwd);
  next.rewrites[filePath] = hash;
  saveBypasserState(cwd, next);
  return next;
}

export function recordDetection(
  cwd: string,
  filePath: string,
  contentHash: string,
  score: number,
  state?: BypasserState
): BypasserState {
  const next = state ?? loadBypasserState(cwd);
  next.detections[filePath] = { contentHash, score };
  saveBypasserState(cwd, next);
  return next;
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
