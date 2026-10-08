/**
 * `bypasser stats` — aggregate the structured audit log (`.bypasser.log.jsonl`).
 *
 * Why: the pipeline already records every decision, but only as free-text in
 * `.bypasser.log` plus transient toasts. There was no way to answer the
 * questions that actually drive tuning:
 *
 *   - How often does the detector flag a file, and how often does the rewrite
 *     succeed vs get rejected by a guard?
 *   - Which provider/model has the best end-to-end success rate? (A model that
 *     returns truncated fragments shows up as a high rejection rate.)
 *   - Which files keep getting flagged and never improve?
 *
 * The aggregation is a pure function over parsed events so it is trivial to
 * test and never touches the filesystem itself.
 */
import type { AuditLogEvent } from "./logger.js";

export interface FileHotspot {
  path: string;
  /** Times this file was seen above threshold but not humanized. */
  unresolved: number;
  /** Times it was flagged at all (score >= threshold). */
  flagged: number;
}

export interface AuditStats {
  /** Number of audit runs (commits/sessions) recorded. */
  runs: number;
  totalFiles: number;
  rewrittenFiles: number;
  rejectedFiles: number;
  errorFiles: number;
  /** Files that were flagged (score >= threshold) at least once. */
  flaggedFiles: number;
  /** Humanization success rate: rewritten / (rewritten + rejected + error). */
  successRate: number;
  /** Rejection reasons keyed by the leading reason word (truncated, indent, …). */
  rejectionReasons: Record<string, number>;
  /** Per provider+model breakdown, sorted by run count. */
  providers: Array<{
    provider: string;
    model: string;
    runs: number;
    rewrittenFiles: number;
    rejectedFiles: number;
    errorFiles: number;
    successRate: number;
  }>;
  /** Files most often left unresolved, worst first. */
  hotspots: FileHotspot[];
  /** ISO timestamp of the most recent event, or null when empty. */
  lastRun: string | null;
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Normalise a free-text skip reason to a coarse bucket for aggregation. */
export function bucketReason(reason: string | undefined): string {
  if (!reason) return "unknown";
  const r = reason.toLowerCase();
  if (r.startsWith("rewrite error")) return "api-error";
  const m = r.match(/rewrite rejected \(([a-z-]+)\)/);
  if (m) return m[1];
  if (r.startsWith("already humanized")) return "unchanged";
  if (r.startsWith("too few changed lines")) return "too-few-lines";
  if (r.startsWith("file too large")) return "too-large";
  if (r.startsWith("dry-run")) return "dry-run";
  return "other";
}

/** Classify a file status from its recorded fields. */
function fileStatus(f: AuditLogEvent["files"][number]): string {
  if (f.status) return f.status;
  if (f.reason?.startsWith("rewrite error")) return "error";
  if (f.reason?.startsWith("rewrite rejected")) return "rejected";
  if (f.reason) return "skipped";
  return f.score >= f.threshold ? "unresolved" : "ok";
}

export function computeStats(events: AuditLogEvent[]): AuditStats {
  const providers = new Map<
    string,
    { provider: string; model: string; runs: number; rewrittenFiles: number; rejectedFiles: number; errorFiles: number }
  >();
  const rejectionReasons: Record<string, number> = {};
  const hotspots = new Map<string, FileHotspot>();
  const flaggedPaths = new Set<string>();

  let totalFiles = 0;
  let rewrittenFiles = 0;
  let rejectedFiles = 0;
  let errorFiles = 0;

  for (const ev of events) {
    totalFiles += ev.totalFiles ?? ev.files.length;
    rewrittenFiles += ev.rewrittenFiles ?? 0;
    rejectedFiles += ev.rejectedFiles ?? 0;
    errorFiles += ev.errorFiles ?? 0;

    const key = `${ev.provider ?? "?"}::${ev.model ?? "?"}`;
    const p =
      providers.get(key) ??
      { provider: ev.provider ?? "?", model: ev.model ?? "?", runs: 0, rewrittenFiles: 0, rejectedFiles: 0, errorFiles: 0 };
    p.runs++;
    p.rewrittenFiles += ev.rewrittenFiles ?? 0;
    p.rejectedFiles += ev.rejectedFiles ?? 0;
    p.errorFiles += ev.errorFiles ?? 0;
    providers.set(key, p);

    for (const f of ev.files) {
      const status = fileStatus(f);
      const flagged = f.score >= f.threshold;
      if (flagged) {
        flaggedPaths.add(f.path);
        const h = hotspots.get(f.path) ?? { path: f.path, unresolved: 0, flagged: 0 };
        h.flagged++;
        if (status !== "rewritten" && status !== "ok") h.unresolved++;
        hotspots.set(f.path, h);
      }
      if (status === "rejected") {
        const bucket = bucketReason(f.reason);
        rejectionReasons[bucket] = (rejectionReasons[bucket] ?? 0) + 1;
      }
    }
  }

  const hotspotsArr = [...hotspots.values()]
    .filter((h) => h.unresolved > 0)
    .sort((a, b) => b.unresolved - a.unresolved || b.flagged - a.flagged);

  const attempts = rewrittenFiles + rejectedFiles + errorFiles;

  return {
    runs: events.length,
    totalFiles,
    rewrittenFiles,
    rejectedFiles,
    errorFiles,
    flaggedFiles: flaggedPaths.size,
    successRate: safeRate(rewrittenFiles, attempts),
    rejectionReasons,
    providers: [...providers.values()]
      .map((p) => ({
        ...p,
        successRate: safeRate(p.rewrittenFiles, p.rewrittenFiles + p.rejectedFiles + p.errorFiles),
      }))
      .sort((a, b) => b.runs - a.runs),
    hotspots: hotspotsArr,
    lastRun: events.length > 0 ? events[events.length - 1].iso : null,
  };
}

function pct(x: number): string {
  return (x * 100).toFixed(0) + "%";
}

export function renderStats(stats: AuditStats): string {
  const lines: string[] = [];
  lines.push("BypasserAI — audit stats");
  lines.push("=".repeat(48));
  if (stats.runs === 0) {
    lines.push("No structured audit history yet (.bypasser.log.jsonl is empty).");
    lines.push("Run a commit or `bypasser audit` first.");
    return lines.join("\n");
  }
  lines.push(`runs recorded     : ${stats.runs}`);
  lines.push(`last run          : ${stats.lastRun}`);
  lines.push(`files scanned     : ${stats.totalFiles}`);
  lines.push(`files flagged (AI): ${stats.flaggedFiles}`);
  lines.push(`humanized         : ${stats.rewrittenFiles}`);
  lines.push(`rejected by guards: ${stats.rejectedFiles}`);
  lines.push(`API errors        : ${stats.errorFiles}`);
  lines.push(`success rate      : ${pct(stats.successRate)} (of flagged attempts)`);
  lines.push("");

  if (Object.keys(stats.rejectionReasons).length > 0) {
    lines.push("rejection / skip reasons");
    for (const [reason, count] of Object.entries(stats.rejectionReasons).sort(
      (a, b) => b[1] - a[1]
    )) {
      lines.push(`  ${reason.padEnd(16)} ${count}`);
    }
    lines.push("");
  }

  if (stats.providers.length > 0) {
    lines.push("by provider / model");
    for (const p of stats.providers) {
      lines.push(
        `  ${p.provider}/${p.model}: ${p.runs} run(s), ` +
          `${p.rewrittenFiles} humanized, ${p.rejectedFiles} rejected, ${p.errorFiles} errors ` +
          `(${pct(p.successRate)} success)`
      );
    }
    lines.push("");
  }

  if (stats.hotspots.length > 0) {
    lines.push("files that keep getting flagged but never improve");
    for (const h of stats.hotspots.slice(0, 10)) {
      lines.push(`  ${h.path}: ${h.unresolved} unresolved / ${h.flagged} flagged`);
    }
  }

  return lines.join("\n").trimEnd();
}
