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
import {
  TRUNCATION_LINE_RATIO,
  TRUNCATION_MIN_LINES,
} from "./rewrite-constants.js";

export interface StagedFile {
  path: string;
  diff: string;
  content: string;
}

export type FileSource = "staged" | "worktree";

function git(args: string[], cwd: string): string {
  // suppress stderr — callers probe paths expected to fail (staged deletions etc)
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function getWorkingTreeFiles(
  cwd: string,
  config: BypasserConfig
): StagedFile[] {
  const tracked = gitOrNull(["diff", "HEAD", "--name-only"], cwd) ?? "";
  const untracked =
    gitOrNull(["ls-files", "--others", "--exclude-standard"], cwd) ?? "";

  const allIgnore = [...BUILT_IN_IGNORE, ...config.ignore];

  const paths = [...tracked.split("\n"), ...untracked.split("\n")]
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .filter((f) => !shouldIgnore(f, allIgnore));

  // staged+modified file can show up in both lists
  const unique = [...new Set(paths)];
  const result: StagedFile[] = [];

  for (const filePath of unique) {
    let content: string;
    try {
      content = readFileSync(resolve(cwd, filePath), "utf8");
    } catch {
      continue; // deleted or binary
    }

    let diff = gitOrNull(["diff", "HEAD", "--", filePath], cwd);
    if (diff === null || diff.trim() === "") {
      diff = synthesizeAddedDiff(filePath, content);
    }

    result.push({ path: filePath, diff, content });
  }

  return result;
}

function synthesizeAddedDiff(filePath: string, content: string): string {
  const body = content
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return `--- /dev/null\n+++ b/${filePath}\n${body}`;
}

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

  const fullPatch = gitOrNull(["diff", "--cached"], cwd) ?? "";
  const diffsByPath = splitCachedDiffByPath(fullPatch);

  const result: StagedFile[] = [];

  for (const filePath of files) {
    try {
      const diff =
        diffsByPath.get(filePath) ??
        git(["diff", "--cached", "--", filePath], cwd);

      // staged (index) version — may differ from worktree under `git add -p`
      const content = git(["show", `:${filePath}`], cwd);

      result.push({ path: filePath, diff, content });
    } catch {
      // deleted or binary — skip
    }
  }

  return result;
}

export function splitCachedDiffByPath(fullPatch: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fullPatch.trim()) return map;

  const parts = fullPatch.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const block = "diff --git " + part;
    const m = block.match(/^diff --git a\/(.+?) b\/(.+?)\n/m);
    if (!m) continue;
    const filePath = m[2];
    map.set(filePath, block.trimEnd() + "\n");
  }
  return map;
}

/**
 * Re-stages a file after rewriting. Safety-first:
 *
 * 1. Refuses empty content over a non-empty file.
 * 2. Backs up current on-disk content to `<path>.bak` before any write.
 * 3. Writes to a tmp file then renames atomically.
 *
 * Throws on destructive writes — caller keeps the commit safe.
 */
export function restageFile(
  filePath: string,
  newContent: string,
  cwd: string
): void {
  const target = resolve(cwd, filePath);

  if (newContent.trim() === "" && existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing.trim() !== "") {
      throw new Error(
        `refusing to overwrite ${filePath} with empty content (original has ${existing.split("\n").length} lines)`
      );
    }
  }

  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    const existingLines = existing.split("\n").length;
    const newLines = newContent.split("\n").length;

    if (
      existingLines >= TRUNCATION_MIN_LINES &&
      newLines < existingLines * TRUNCATION_LINE_RATIO
    ) {
      throw new Error(
        `refusing to overwrite ${filePath}: new content has ${newLines} lines vs ${existingLines} original (truncation guard)`
      );
    }

    // backup before touching anything
    copyFileSync(target, `${target}.bak`);
  }

  const tmp = `${target}.bypasser.tmp`;
  writeFileSync(tmp, newContent, "utf8");
  renameSync(tmp, target);

  git(["add", "--", filePath], cwd);
}

export function shouldIgnore(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(filePath, pattern)) return true;
  }
  return false;
}

export function matchGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".+")
    .replace(/\*/g, "[^/]+");
  return new RegExp(`(^|/)${escaped}($|/)`).test(filePath);
}