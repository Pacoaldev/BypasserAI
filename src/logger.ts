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
      // create with a header so the file is readable from the start
      writeFileSync(logPath, "# bypasser-ai — commit scan log\n", "utf8");
    }
    appendFileSync(logPath, block, "utf8");
  } catch {
    // never block the commit because of a log write failure
  }
}

// ---------------------------------------------------------------------------
// Rewrite state — remembers which content hashes we already humanized so we
// don't re-call the API on an unchanged file across commits.
// ---------------------------------------------------------------------------

type RewriteState = Record<string, string>;

export function loadRewriteState(cwd: string): RewriteState {
  const statePath = resolve(cwd, STATE_FILE);
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as RewriteState;
  } catch {
    return {};
  }
}

export function saveRewriteState(cwd: string, state: RewriteState): void {
  const statePath = resolve(cwd, STATE_FILE);
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // non-fatal
  }
}

/** Record a successful rewrite hash for a file. Returns the mutated state. */
export function recordRewrite(
  cwd: string,
  filePath: string,
  hash: string
): RewriteState {
  const state = loadRewriteState(cwd);
  state[filePath] = hash;
  saveRewriteState(cwd, state);
  return state;
}
