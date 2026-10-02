import { detectAI, countChangedLines } from "./detector.js";
import { rewriteFile, createRewriteClient, contentHash } from "./rewriter.js";
import { getStagedFiles, restageFile } from "./git.js";
import {
  loadConfig,
  resolveThreshold,
  scaledTimeoutMs,
  resolveEffectiveRewriteScope,
} from "./config.js";
import { matchGlob } from "./git.js";
import {
  writeLog,
  loadBypasserState,
  recordRewrite,
  recordDetection,
  cachedDetectionScore,
} from "./logger.js";
import { notifyWindows } from "./notifier.js";
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
}

function scoreBar(score: number): string {
  const filled = Math.round(score * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
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
      bypasserState = recordDetection(cwd, file.path, hash, detection.score, bypasserState);
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
    const maxTimeout = Math.max(
      ...pending.map((p) => scaledTimeoutMs(config, p.lineCount))
    );
    const client = createRewriteClient(config, maxTimeout);

    const rewriteOutcomes = await mapPool(pending, config.rewriteConcurrency, (item) =>
      processRewrite(cwd, config, client, item, bypasserState.rewrites)
    );

    for (const outcome of rewriteOutcomes) {
      if (outcome.hash) {
        bypasserState = recordRewrite(cwd, outcome.path, outcome.hash, bypasserState);
      }
      results.push(outcome.result);
    }
  }

  const rewrittenFiles = results.filter((r) => r.rewritten).length;
  const errorFiles = results.filter((r) => r.skippedReason?.startsWith("rewrite error")).length;
  const rejectedFiles = results.filter((r) =>
    r.skippedReason?.startsWith("rewrite rejected")
  ).length;

  const result: AuditResult = {
    files: results,
    totalFiles: results.length,
    rewrittenFiles,
    errorFiles,
    rejectedFiles,
  };

  if (results.length > 0) {
    _writeLogAndNotify(cwd, result);
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

function _writeLogAndNotify(cwd: string, result: AuditResult): void {
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
    logLines.push(`  → ${result.errorFiles} file(s) could NOT be rewritten (API error) — see lines above`);
  }

  writeLog(cwd, logLines);

  if (result.rewrittenFiles > 0) {
    notifyWindows({
      title: "BypasserAI — Humanized",
      message: `${result.rewrittenFiles} file(s) rewritten before commit.`,
      type: "warning",
    });
  } else if (result.errorFiles > 0) {
    notifyWindows({
      title: "BypasserAI — Rewrite failed",
      message: `${result.errorFiles} file(s) needed rewriting but the API call failed. Check .bypasser.log.`,
      type: "error",
    });
  } else if (result.rejectedFiles > 0) {
    notifyWindows({
      title: "BypasserAI — Rewrite rejected",
      message: `${result.rejectedFiles} file(s) failed safety checks; originals kept.`,
      type: "warning",
    });
  } else {
    notifyWindows({
      title: "BypasserAI — Clean",
      message: `${result.totalFiles} file(s) scanned. All ok.`,
      type: "info",
    });
  }
}
