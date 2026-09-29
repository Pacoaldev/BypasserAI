import { execFileSync } from "child_process";
import { writeFileSync, readFileSync } from "fs";
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
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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

/** Re-stages a file after rewriting its content. */
export function restageFile(filePath: string, newContent: string, cwd: string): void {
  writeFileSync(resolve(cwd, filePath), newContent, "utf8");
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
