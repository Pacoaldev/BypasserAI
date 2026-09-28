import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { BUILT_IN_IGNORE } from "./config.js";
import type { BypasserConfig } from "./config.js";

export interface StagedFile {
  path: string;
  diff: string;
  content: string;
}

/** Run a git command with an argv array — avoids shell quoting/injection. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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
