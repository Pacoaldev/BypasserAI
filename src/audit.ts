import { detectAI, extractAddedLines } from "./detector.js";
import { rewriteFile } from "./rewriter.js";
import { getStagedFiles, restageFile } from "./git.js";
import { loadConfig } from "./config.js";
import { writeLog } from "./logger.js";
import { notifyWindows } from "./notifier.js";
import type { DetectorResult } from "./detector.js";

export interface FileAuditResult {
  path: string;
  score: number;
  signals: DetectorResult["signals"];
  rewritten: boolean;
  skippedReason?: string;
}

export interface AuditResult {
  files: FileAuditResult[];
  totalFiles: number;
  rewrittenFiles: number;
}

function scoreBar(score: number): string {
  const filled = Math.round(score * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
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
  const results: FileAuditResult[] = [];

  for (const file of staged) {
    const added = extractAddedLines(file.diff);

    if (added.trim().split("\n").length < 5) {
      results.push({
        path: file.path,
        score: 0,
        signals: [],
        rewritten: false,
        skippedReason: "too few changed lines",
      });
      continue;
    }

    const detection = detectAI(added);

    if (opts.verbose) {
      const fired = detection.signals.filter((s) => s.fired);
      console.log(`\n[${file.path}] score: ${(detection.score * 100).toFixed(0)}%`);
      if (fired.length > 0) {
        fired.forEach((s) => console.log(`  ✗ [${s.family}] ${s.description}`));
      } else {
        console.log("  ✓ No AI signals detected");
      }
    }

    if (detection.score < config.threshold) {
      results.push({
        path: file.path,
        score: detection.score,
        signals: detection.signals,
        rewritten: false,
      });
      continue;
    }

    if (opts.dryRun) {
      results.push({
        path: file.path,
        score: detection.score,
        signals: detection.signals,
        rewritten: false,
        skippedReason: "dry-run mode",
      });
      continue;
    }

    try {
      const res = await rewriteFile(file.path, file.content, config);
      if (res.changed) {
        restageFile(file.path, res.rewritten, cwd);
      }
      results.push({
        path: file.path,
        score: detection.score,
        signals: detection.signals,
        rewritten: res.changed,
      });
    } catch (err) {
      console.error(`[bypasser] rewrite failed for ${file.path}:`, err);
      results.push({
        path: file.path,
        score: detection.score,
        signals: detection.signals,
        rewritten: false,
        skippedReason: "rewrite error",
      });
    }
  }

  const rewrittenFiles = results.filter((r) => r.rewritten).length;
  const result: AuditResult = { files: results, totalFiles: results.length, rewrittenFiles };

  // --- Log + notify (non-blocking, always runs) ---
  if (results.length > 0) {
    _writeLogAndNotify(cwd, result);
  }

  return result;
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

    // log fired signals for rewritten or high-score files
    if (f.rewritten || f.score >= 0.5) {
      const fired = f.signals.filter((s) => s.fired);
      fired.forEach((s) => logLines.push(`    ↳ [${s.family}] ${s.description}`));
    }
  }

  if (result.rewrittenFiles > 0) {
    logLines.push(`  → ${result.rewrittenFiles} file(s) humanized and re-staged`);
  }

  // write to .bypasser.log
  writeLog(cwd, logLines);

  // Windows toast
  if (result.rewrittenFiles > 0) {
    notifyWindows({
      title: "BypasserAI — Humanized",
      message: `${result.rewrittenFiles} file(s) rewritten before commit.`,
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
