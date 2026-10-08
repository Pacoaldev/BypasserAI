/**
 * Configuration secret hygiene.
 *
 * `.bypasser.json` supports an `apiKey` field, and that file lives at the
 * project root — exactly where a `git add .` will pick it up. A user who drops
 * a real key into the config instead of exporting `BYPASSER_API_KEY` can leak it
 * to the repository the first time they commit.
 *
 * There is no way to "fix" this from the tool side other than warning loudly and
 * making the safe path (env var) the obvious one. This module produces the
 * findings; the CLI surfaces them on `init` / `install`.
 *
 * The checks are pure functions over strings so they are trivially testable and
 * never touch the filesystem from inside a predicate.
 */

export interface ConfigSecretFindings {
  /** True when `.bypasser.json` carries a non-empty `apiKey`. */
  hasInlineApiKey: boolean;
  /** True when the config file is listed in `.gitignore` (so it won't commit). */
  configGitignored: boolean;
  /**
   * True when the file has an inline key AND is NOT git-ignored — the actual
   * leak risk worth a red warning.
   */
  atRisk: boolean;
}

/** Extract the `apiKey` string from raw `.bypasser.json` text, if present. */
export function extractInlineApiKey(configJson: string): string | null {
  try {
    const parsed = JSON.parse(configJson) as { apiKey?: unknown };
    if (typeof parsed.apiKey === "string" && parsed.apiKey.trim().length > 0) {
      return parsed.apiKey.trim();
    }
  } catch {
    // unparseable config — nothing to warn about here (loadConfig handles it)
  }
  return null;
}

/**
 * True when `gitignore` content would ignore the config file. Matches exact
 * entries (`.bypasser.json`), globs, and a bare `*.json`-style blanket rule is
 * NOT treated as protection because it would also ignore every other json — we
 * only accept a rule that clearly targets the bypasser config: `.bypasser.json`
 * or a wildcard that matches it exactly.
 */
export function isConfigGitignored(gitignore: string): boolean {
  const lines = gitignore
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  for (const line of lines) {
    const pattern = line.replace(/^\//, "");
    if (pattern === ".bypasser.json") return true;
    // A leading-dot file glob like `.bypasser.*` also covers it.
    if (pattern === ".bypasser.*") return true;
  }
  return false;
}

/** Combine the raw inputs into the finding set the CLI prints. */
export function inspectConfigSecrets(
  configJson: string | null,
  gitignore: string | null
): ConfigSecretFindings {
  const hasInlineApiKey = configJson !== null && extractInlineApiKey(configJson) !== null;
  const configGitignored = gitignore !== null && isConfigGitignored(gitignore);
  return {
    hasInlineApiKey,
    configGitignored,
    atRisk: hasInlineApiKey && !configGitignored,
  };
}

/**
 * Redact a key for display: keep a short prefix/suffix so the user recognises
 * it, never enough to reconstruct it.
 */
export function redactKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
