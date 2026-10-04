/**
 * Real syntax guard for rewritten files.
 *
 * ## Why this exists
 *
 * The heuristic guards in `rewrite-validate.ts` are deliberately conservative:
 * `looksIndentBroken` only rejects a rewrite when indentation is *systemically*
 * flattened (a collapse in both the indented-line ratio AND the median indent).
 * A single mis-indented line — exactly the failure that produced an
 * `IndentationError` in a 2800-line Python file assembled from many LLM chunks
 * — sails straight through every heuristic and lands on disk.
 *
 * This module closes that gap with an *actual parser* when one is available:
 * it runs Python's `ast.parse` (or `JSON.parse`) over the candidate content and
 * rejects anything that does not parse. The check is best-effort: if the
 * interpreter is not installed, it does not block (a commit must never hang or
 * fail just because Python is missing) — it only reports that it could not run.
 *
 * Only languages with a cheap, ubiquitous, dependency-free parser are covered.
 * Falling back to "no check" for everything else is intentional: a wrong
 * rejection is worse than a missed one, and the rest of the pipeline still has
 * the heuristic guards.
 */

import { spawnSync } from "child_process";

export type SyntaxCheckStatus = "ok" | "invalid" | "unsupported" | "unavailable";

export interface SyntaxCheckResult {
  status: SyntaxCheckStatus;
  /** Human-readable reason, present for `invalid` / `unavailable`. */
  reason?: string;
}

/** Interpreters tried in order for Python parsing. */
const PYTHON_CANDIDATES = ["python", "python3", "py"];

/**
 * Python one-liner that parses stdin and exits non-zero on a syntax error.
 *
 * `compile(...)` is used instead of `ast.parse(...)` for the same effect; both
 * raise `SyntaxError`. The traceback goes to stderr, which we surface verbatim.
 */
const PYTHON_PARSE = "import sys; compile(sys.stdin.read(), '<bypasser>', 'exec')";

function fileExtension(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolve the first Python interpreter that actually runs. Cached per process
 * so a large multi-file commit only pays the probe once.
 */
let pythonResolved: string | null | undefined;

function resolvePython(): string | null {
  if (pythonResolved !== undefined) return pythonResolved;
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ["-c", "pass"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      pythonResolved = candidate;
      return candidate;
    }
  }
  pythonResolved = null;
  return null;
}

/** Parse Python source with the real interpreter. */
function checkPython(code: string): SyntaxCheckResult {
  const interpreter = resolvePython();
  if (!interpreter) {
    return {
      status: "unavailable",
      reason: "no python interpreter (python/python3/py) found on PATH",
    };
  }

  const run = spawnSync(interpreter, ["-c", PYTHON_PARSE], {
    input: code,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  if (run.error) {
    return { status: "unavailable", reason: `python probe error: ${run.error.message}` };
  }
  if (run.status === 0) return { status: "ok" };

  const stderr = (run.stderr || "").trim().split("\n").slice(-1)[0] || "parse error";
  return { status: "invalid", reason: stderr };
}

/** Parse JSON with the built-in parser. */
function checkJson(code: string): SyntaxCheckResult {
  try {
    JSON.parse(code);
    return { status: "ok" };
  } catch (err) {
    return { status: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validate `code` for `filePath` using a real parser when one is available.
 *
 * Returns `{ status: "unsupported" }` for languages without a cheap local
 * parser, and `{ status: "unavailable" }` when the parser exists in principle
 * but its interpreter is missing — callers must treat those as *non-blocking*.
 */
export function checkSyntax(code: string, filePath: string): SyntaxCheckResult {
  const ext = fileExtension(filePath);
  if (ext === "py" || ext === "pyi") return checkPython(code);
  if (ext === "json") return checkJson(code);
  return { status: "unsupported" };
}

/**
 * Convenience predicate: true when the content is provably invalid and the
 * caller MUST keep the original. Non-blocking statuses return false.
 */
export function isSyntaxInvalid(code: string, filePath: string): boolean {
  return checkSyntax(code, filePath).status === "invalid";
}
