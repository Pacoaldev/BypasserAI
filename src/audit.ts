import { detectAI, extractAddedLines } from "./detector.js";
import { rewriteFile } from "./rewriter.js";
import { getStagedFiles, restageFile } from "./git.js";
import { loadConfig } from "./config.js";
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

/**
 * Full audit pipeline:
 * 1. Get staged files
 * 2. Score each with the detector
 * 3. Rewrite files above threshold via OpenAI-compatible API
 * 4. Re-stage rewritten files
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

    // skip files with too few new lines to meaningfully score
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

    // score above threshold — rewrite
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
      // rewrite failed — log and let the commit proceed untouched
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

  return {
    files: results,
    totalFiles: results.length,
    rewrittenFiles,
  };
}
