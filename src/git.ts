import { execFileSync } from "child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  copyFileSync,
} from "fs";
import { resolve } from "path";
import { BUILT_IN_IGNORE } from "./config.js";
import type { BypasserConfig } from "./config.js";

export interface StagedFile {
  path: string;
  diff: string;
  content: string;
}

/** Where a set of candidate files is read from. */
export type FileSource = "staged" | "worktree";

/** Run a git command with an argv array — avoids shell quoting/injection. */
function git(args: string[], cwd: string): string {
  // Capture stderr instead of inheriting it: several callers probe paths that
  // are expected to fail (e.g. `git show :path` on a staged deletion) and
  // swallow the error. Inheriting stderr would leak `fatal: path ... does not
  // exist` into the user's commit output on every file deletion.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run a git command and return stdout, or null when it exits non-zero. */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Returns the files that differ from HEAD in the *working tree* — staged,
 * unstaged and untracked alike — so the tool can score what you are currently
 * editing without you having to `git add` anything first.
 *
 * The returned `content` is the on-disk working-tree file; `diff` is the unified
 * diff against HEAD (synthesised for untracked files, which git has no diff for).
 */
export function getWorkingTreeFiles(
  cwd: string,
  config: BypasserConfig
): StagedFile[] {
  const tracked = gitOrNull(["diff", "HEAD", "--name-only"], cwd) ?? "";
  const untracked = gitOrNull(["ls-files", "--others", "--exclude-standard"], cwd) ?? "";

  const allIgnore = [...BUILT_IN_IGNORE, ...config.ignore];
  const paths = [...tracked.split("\n"), ...untracked.split("\n")]
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .filter((f) => !shouldIgnore(f, allIgnore));

  // de-duplicate (a staged+modified file can appear in both lists)
  const unique = [...new Set(paths)];
  const result: StagedFile[] = [];

  for (const filePath of unique) {
    let content: string;
    try {
      content = readFileSync(resolve(cwd, filePath), "utf8");
    } catch {
      continue; // deleted or binary — skip
    }

    // unified diff vs HEAD; untracked files have none, so synthesise one
    let diff = gitOrNull(["diff", "HEAD", "--", filePath], cwd);
    if (diff === null || diff.trim() === "") {
      diff = synthesizeAddedDiff(filePath, content);
    }

    result.push({ path: filePath, diff, content });
  }

  return result;
}

/** Build a fake unified diff treating every line as added (for untracked files). */
function synthesizeAddedDiff(filePath: string, content: string): string {
  const body = content
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return `--- /dev/null\n+++ b/${filePath}\n${body}`;
}

/** Returns the list of staged files that are eligible for humanization. */
export function getStagedFiles(
  cwd: string,
  config: BypasserConfig
): StagedFile[] {
  let raw: string;
  try {
    raw = git(["diff", "--cached", "--name-only"], cwd).trim();
  } catch {
    return [];
  }

  if (!raw) return [];

  const allIgnore = [...BUILT_IN_IGNORE, ...config.ignore];
  const files = raw
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .filter((f) => !shouldIgnore(f, allIgnore));

  const result: StagedFile[] = [];

  for (const filePath of files) {
    try {
      const diff = git(["diff", "--cached", "--", filePath], cwd);

      // read the *staged* (index) version — this is what will be committed,
      // which may differ from the working tree under `git add -p`.
      const content = git(["show", `:${filePath}`], cwd);

      result.push({ path: filePath, diff, content });
    } catch {
      // file might be deleted or binary — skip
    }
  }

  return result;
}

/**
 * Re-stages a file after rewriting its content — *safely*.
 *
 * Safety is non-negotiable here: this is the single point where a bad rewrite
 * could destroy a user's file. The 2026-09 incident happened exactly here — a
 * truncated model response (2570 → 474 lines) was written straight over the
 * original with no recovery path. This function now:
 *
 *   1. Refuses to write empty content over a non-empty file (a truncated
 *      response that sanitized to "" is the most destructive possible write).
 *   2. Copies the current on-disk content to `<path>.bak` before touching it,
 *      so the pre-rewrite version is always recoverable.
 *   3. Writes to a temp file and atomically renames it into place, so an
 *      interrupted write can never leave a half-written file.
 *
 * Throws (rather than silently proceeding) when the write would be destructive;
 * callers treat that as a failed rewrite and keep the commit safe.
 */
export function restageFile(filePath: string, newContent: string, cwd: string): void {
  const target = resolve(cwd, filePath);

  // Guard 1: never blank out an existing non-empty file.
  if (newContent.trim() === "" && existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing.trim() !== "") {
      throw new Error(
        `refusing to overwrite ${filePath} with empty content (original has ${existing.split("\n").length} lines)`
      );
    }
  }

  // Guard 2: back up the current content before any write.
  if (existsSync(target)) {
    copyFileSync(target, `${target}.bak`);
  }

  // Guard 3: atomic write — temp file + rename, never a partial file on disk.
  const tmp = `${target}.bypasser.tmp`;
  writeFileSync(tmp, newContent, "utf8");
  renameSync(tmp, target);

  git(["add", "--", filePath], cwd);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function shouldIgnore(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(filePath, pattern)) return true;
  }
  return false;
}

/** Minimal glob: supports `*` and `**` wildcards, anchored to path segments. */
export function matchGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".+")
    .replace(/\*/g, "[^/]+");
  return new RegExp(`(^|/)${escaped}($|/)`).test(filePath);
}
