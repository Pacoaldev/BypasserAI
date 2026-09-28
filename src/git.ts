import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { BUILT_IN_IGNORE } from "./config.js";
import type { BypasserConfig } from "./config.js";

export interface StagedFile {
  path: string;
  diff: string;
  content: string;
}

/** Returns the list of staged files that are eligible for humanization. */
export function getStagedFiles(
  cwd: string,
  config: BypasserConfig
): StagedFile[] {
  let raw: string;
  try {
    raw = execSync("git diff --cached --name-only", {
      cwd,
      encoding: "utf8",
    }).trim();
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
      const diff = execSync(`git diff --cached -- "${filePath}"`, {
        cwd,
        encoding: "utf8",
      });

      // read the working-tree version (what will actually be committed)
      const content = readFileSync(resolve(cwd, filePath), "utf8");

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
  execSync(`git add "${filePath}"`, { cwd });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldIgnore(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(filePath, pattern)) return true;
  }
  return false;
}

function matchGlob(filePath: string, pattern: string): boolean {
  // minimal glob: support * and ** wildcards
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".+")
    .replace(/\*/g, "[^/]+");
  return new RegExp(`(^|/)${escaped}($|/)`).test(filePath);
}
