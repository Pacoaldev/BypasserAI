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
  TRUNCATION_MIN_LINES,
  COMPRESSION_LINE_RATIO,
} from "./rewrite-constants.js";

export interface StagedFile {
  path: string;
  diff: string;
  content: string;
}

export type FileSource = "staged" | "worktree";

function git(args: string[], cwd: string): string {
  // stderr suppressed — callers probe paths that may not exist (deletions, etc)
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

  // a staged+modified file can appear in both lists
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
  const lines = content.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
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

      // index version — may differ from worktree if `git add -p` was used
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
 * The line-count guard here is a last-resort backstop against a catastrophic
 * write, NOT the primary truncation decision: the rewriter already ran the
 * finish-reason-aware completeness check with full context (see
 * `looksTruncated` in rewriter.ts). This layer only has the two strings, so it
 * cannot tell a clean-stop compression from a cutoff — it therefore uses the
 * severe `COMPRESSION_LINE_RATIO` floor, which still catches the original
 * `providers.rs` disaster (~18%) but does not re-reject a legitimate rewrite
 * that merely stripped narration down to ~40-60% of the original.
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
      newLines < existingLines * COMPRESSION_LINE_RATIO
    ) {
      throw new Error(
        `refusing to overwrite ${filePath}: new content has ${newLines} lines vs ${existingLines} original (severe-shrink guard)`
      );
    }

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
  const rx = new RegExp(`(^|/)${escaped}($|/)`);
  return rx.test(filePath);
}