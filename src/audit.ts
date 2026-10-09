import { detectAI, countChangedLines } from "./detector.js";
import { rewriteFile, createRewriteClient, contentHash } from "./rewriter.js";
import { getStagedFiles, restageFile, getTrackedFiles } from "./git.js";
import {
  loadConfig,
  resolveThreshold,
  scaledTimeoutMs,
  resolveEffectiveRewriteScope,
} from "./config.js";
import { matchGlob } from "./git.js";
import {
  writeLog,
  writeAuditEvent,
  saveBypasserState,
  loadBypasserState,
  recordRewriteInMemory,
  recordDetectionInMemory,
  cachedDetectionScore,
  pruneState,
} from "./logger.js";
import { notify } from "./notifier.js";
import { addedLineFraction } from "./diff-hunks.js";
import { mapPool } from "./concurrency.js";
import type { DetectorResult } from "./detector.js";
import type { BypasserConfig } from "./config.js";
import type { StagedFile } from "./git.js";

export interface FileAuditResult {
  path: string;
  score: number;
  threshold: number;
  signals: DetectorResult["signals"];
  rewritten: boolean;
  skippedReason?: string;
}

export interface AuditResult {
  files: FileAuditResult[];
  totalFiles: number;
  rewrittenFiles: number;
  errorFiles: number;
  rejectedFiles: number;
  /**
   * Files that were *above threshold and not humanized* — either the rewrite
   * was rejected by a safety guard or the API call failed. These are the files
   * `--strict` treats as a failure: the commit still contains AI-shaped code
   * the pipeline could not improve. Empty on a clean run.
   */
  unresolvedFiles: FileAuditResult[];
}

function scoreBar(score: number): string {
  const filled = Math.round(score * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

/**
 * Files the audit flagged as AI-shaped (score at/above their effective
 * threshold) but could not humanize — the set `--strict` gates CI on.
 *
 * A clean file has `score < threshold`; a file skipped for being too large or
 * for having too few changed lines is never scored as AI (score 0) and so never
 * lands here. This leaves exactly the files where detection said "this is AI"
 * and the pipeline failed to fix it (guard rejection or API error).
 */
export function selectUnresolvedFiles(files: FileAuditResult[]): FileAuditResult[] {
  return files.filter((f) => !f.rewritten && f.score >= f.threshold);
}

/**
 * Reduce a base URL to its host for the structured log — never persisting a
 * path/query that might carry a key embedded by a proxy setup.
 */
export function providerHost(baseURL: string): string {
  try {
    return new URL(baseURL).host || baseURL;
  } catch {
    return baseURL;
  }
}

/** Coarse status bucket recorded per file in the structured log. */
export function auditFileStatus(f: FileAuditResult): string {
  if (f.rewritten) return "rewritten";
  if (f.skippedReason?.startsWith("rewrite error")) return "error";
  if (f.skippedReason?.startsWith("rewrite rejected")) return "rejected";
  if (f.skippedReason) return "skipped";
  return f.score >= f.threshold ? "unresolved" : "ok";
}

interface PendingRewrite {
  file: StagedFile;
  threshold: number;
  detection: DetectorResult;
  lineCount: number;
  scope: ReturnType<typeof resolveEffectiveRewriteScope>;
}

/**
 * Full audit pipeline:
 * 1. Get staged files
 * 2. Score each with the detector
 * 3. Rewrite files above threshold via OpenAI-compatible API
 * 4. Re-stage rewritten files
 * 5. Write .bypasser.log + fire Windows toast notification
 */
export async function runAudit(opts: {
  cwd?: string;
  dryRun?: boolean;
  verbose?: boolean;
}): Promise<AuditResult> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);

  if (!config.apiKey && !opts.dryRun) {
    throw new Error(
      "No API key configured. Set BYPASSER_API_KEY or OPENAI_API_KEY, or add apiKey to .bypasser.json"
    );
  }

  const staged = getStagedFiles(cwd, config);
  let bypasserState = loadBypasserState(cwd);
  const results: FileAuditResult[] = [];
  const pending: PendingRewrite[] = [];

  for (const file of staged) {
    const threshold = resolveThreshold(file.path, config, matchGlob);

    if (countChangedLines(file.diff) < 5) {
      results.push({
        path: file.path,
        score: 0,
        threshold,
        signals: [],
        rewritten: false,
        skippedReason: "too few changed lines",
      });
      continue;
    }

    const lineCount = file.content.split("\n").length;
    const hash = contentHash(file.content);
    const changedLines = countChangedLines(file.diff);

    const scope = resolveEffectiveRewriteScope(config, {
      lineCount,
      changedLines,
      addedFraction: addedLineFraction(file.diff, lineCount),
    });

    const overMax =
      config.maxFileLines > 0 &&
      lineCount > config.maxFileLines &&
      scope !== "diff" &&
      scope !== "chunk";

    if (overMax) {
      results.push({
        path: file.path,
        score: 0,
        threshold,
        signals: [],
        rewritten: false,
        skippedReason: `file too large (${lineCount} lines > maxFileLines ${config.maxFileLines})`,
      });
      continue;
    }

    let detection: DetectorResult;
    const cachedScore = cachedDetectionScore(bypasserState, file.path, hash);
    if (cachedScore !== undefined) {
      detection = { score: cachedScore, signals: [] };
    } else {
      detection = detectAI(file.content, file.path);
      bypasserState = recordDetectionInMemory(bypasserState, file.path, hash, detection.score);
    }

    if (opts.verbose) {
      const fired = detection.signals.filter((s) => s.fired);
      console.log(`\n[${file.path}] score: ${(detection.score * 100).toFixed(0)}%`);
      if (fired.length > 0) {
        fired.forEach((s) => console.log(`  ✗ [${s.family}] ${s.description}`));
      } else {
        console.log("  ✓ No AI signals detected");
      }
    }

    if (detection.score < threshold) {
      results.push({
        path: file.path,
        score: detection.score,
        threshold,
        signals: detection.signals,
        rewritten: false,
      });
      continue;
    }

    if (opts.dryRun) {
      results.push({
        path: file.path,
        score: detection.score,
        threshold,
        signals: detection.signals,
        rewritten: false,
        skippedReason: "dry-run mode",
      });
      continue;
    }

    pending.push({ file, threshold, detection, lineCount, scope });
  }

  if (pending.length > 0 && !opts.dryRun) {
    const maxTimeout = Math.max(...pending.map((p) => scaledTimeoutMs(config, p.lineCount)));
    const client = createRewriteClient(config, maxTimeout);

    const rewriteOutcomes = await mapPool(pending, config.rewriteConcurrency, (item) =>
      processRewrite(cwd, config, client, item, bypasserState.rewrites)
    );

    for (const outcome of rewriteOutcomes) {
      if (outcome.hash) {
        bypasserState = recordRewriteInMemory(bypasserState, outcome.path, outcome.hash);
      }
      results.push(outcome.result);
    }
  }

  // Prune state entries for files that no longer exist in the repo, then persist
  // the whole state ONCE. Writing per-file (the old behaviour) meant N full
  // synchronous writes per audit — see logger.ts.
  bypasserState = pruneState(bypasserState, getTrackedFiles(cwd)).state;
  saveBypasserState(cwd, bypasserState);

  const rewrittenFiles = results.filter((r) => r.rewritten).length;
  const errorFiles = results.filter((r) => r.skippedReason?.startsWith("rewrite error")).length;
  const rejectedFiles = results.filter((r) =>
    r.skippedReason?.startsWith("rewrite rejected")
  ).length;

  // Files the pipeline flagged as AI-shaped (score at/above their threshold)
  // but could not humanize. A clean file has score < threshold and never lands
  // here; a file skipped for size/few-lines was never scored as AI, so it does
  // not either. Used by `--strict` to gate CI.
  const unresolvedFiles = selectUnresolvedFiles(results);

  const result: AuditResult = {
    files: results,
    totalFiles: results.length,
    rewrittenFiles,
    errorFiles,
    rejectedFiles,
    unresolvedFiles,
  };

  if (results.length > 0) {
    _writeLogAndNotify(cwd, config, result);
  }

  return result;
}

async function processRewrite(
  cwd: string,
  config: BypasserConfig,
  client: ReturnType<typeof createRewriteClient>,
  item: PendingRewrite,
  rewriteHashes: Record<string, string>
): Promise<{ result: FileAuditResult; path: string; hash?: string }> {
  const { file, threshold, detection, lineCount, scope } = item;
  const base: FileAuditResult = {
    path: file.path,
    score: detection.score,
    threshold,
    signals: detection.signals,
    rewritten: false,
  };

  try {
    const res = await rewriteFile(file.path, file.content, config, {
      knownHash: rewriteHashes[file.path],
      timeout: scaledTimeoutMs(config, lineCount),
      client,
      scope,
      diff: file.diff,
    });

    if (res.skipped) {
      return {
        path: file.path,
        result: { ...base, skippedReason: "already humanized (unchanged)" },
      };
    }

    if (res.sanitizerWarning) {
      return {
        path: file.path,
        result: {
          ...base,
          skippedReason: `rewrite rejected (${res.invalidReason ?? "invalid"})`,
        },
      };
    }

    if (res.changed) {
      restageFile(file.path, res.rewritten, cwd);
      return {
        path: file.path,
        result: { ...base, rewritten: true },
        hash: res.hash,
      };
    }

    return { path: file.path, result: base };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[bypasser] rewrite failed for ${file.path}: ${reason}`);
    return {
      path: file.path,
      result: { ...base, skippedReason: `rewrite error: ${reason}` },
    };
  }
}

function _writeLogAndNotify(cwd: string, config: BypasserConfig, result: AuditResult): void {
  const logLines: string[] = [];

  for (const f of result.files) {
    const pct = (f.score * 100).toFixed(0);
    const bar = scoreBar(f.score);

    let status: string;
    if (f.skippedReason) {
      status = `· skipped (${f.skippedReason})`;
    } else if (f.rewritten) {
      status = `✓ humanized & re-staged`;
    } else {
      status = `✓ ok`;
    }

    logLines.push(`  ${f.path}: ${pct}% ${bar} ${status}`);

    if (f.rewritten || f.score >= 0.5) {
      const fired = f.signals.filter((s) => s.fired);
      fired.forEach((s) => logLines.push(`    ↳ [${s.family}] ${s.description}`));
    }
  }

  if (result.rewrittenFiles > 0) {
    logLines.push(`  → ${result.rewrittenFiles} file(s) humanized and re-staged`);
  }
  if (result.rejectedFiles > 0) {
    logLines.push(
      `  → ${result.rejectedFiles} file(s) rewrite rejected by safety checks — originals kept`
    );
  }
  if (result.errorFiles > 0) {
    logLines.push(
      `  → ${result.errorFiles} file(s) could NOT be rewritten (API error) — see lines above`
    );
  }

  writeLog(cwd, logLines);

  // Structured sidecar for `bypasser stats`. Best-effort and never blocking.
  // The provider is reduced to its host so a key embedded in the URL (some
  // proxies) can never be persisted.
  writeAuditEvent(cwd, {
    ts: new Date().toISOString().replace("T", " ").slice(0, 19),
    iso: new Date().toISOString(),
    provider: providerHost(config.baseURL),
    model: config.model,
    totalFiles: result.totalFiles,
    rewrittenFiles: result.rewrittenFiles,
    rejectedFiles: result.rejectedFiles,
    errorFiles: result.errorFiles,
    files: result.files.map((f) => ({
      path: f.path,
      score: f.score,
      threshold: f.threshold,
      status: auditFileStatus(f),
      reason: f.skippedReason,
      signals: f.signals
        .filter((s) => s.fired)
        .map((s) => ({ family: s.family, weight: s.weight })),
    })),
  });

  const mode = config.notifications;
  if (result.rewrittenFiles > 0) {
    notify({
      title: "BypasserAI — Humanized",
      message: `${result.rewrittenFiles} file(s) rewritten before commit.`,
      type: "warning",
      mode,
    });
  } else if (result.errorFiles > 0) {
    notify({
      title: "BypasserAI — Rewrite failed",
      message: `${result.errorFiles} file(s) needed rewriting but the API call failed. Check .bypasser.log.`,
      type: "error",
      mode,
    });
  } else if (result.rejectedFiles > 0) {
    notify({
      title: "BypasserAI — Rewrite rejected",
      message: `${result.rejectedFiles} file(s) failed safety checks; originals kept.`,
      type: "warning",
      mode,
    });
  } else {
    notify({
      title: "BypasserAI — Clean",
      message: `${result.totalFiles} file(s) scanned. All ok.`,
      type: "info",
      mode,
    });
  }
}
