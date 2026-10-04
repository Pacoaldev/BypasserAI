import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface BypasserConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 0–1. Diffs scoring above this threshold are sent for rewrite. Default 0.65 */
  threshold: number;
  /** Max tokens for the rewrite response. Default 16384 */
  maxTokens: number;
  /** Sampling temperature for the rewrite request. Default 0.4 */
  temperature: number;
  /** File globs to always skip (on top of built-ins). */
  ignore: string[];
  /** Per-glob threshold overrides. First matching pattern wins. */
  thresholds: ThresholdRule[];
  /**
   * Base per-request timeout in ms for a rewrite. Large files legitimately take
   * longer, so the effective timeout scales up with file size (see
   * `scaledTimeoutMs`). Default 120000 (2 min).
   */
  timeoutMs: number;
  /**
   * Per-extra-1000-lines increment added to `timeoutMs`. Keeps a 500-line file
   * on the base timeout while giving a 1500-line file real headroom.
   * Default 30000 (30 s per extra 1000 lines).
   */
  timeoutPer1kLinesMs: number;
  /**
   * Hard ceiling on the scaled timeout in ms, so a runaway request cannot hang
   * the commit forever. Default 600000 (10 min).
   */
  maxTimeoutMs: number;
  /**
   * Files longer than this many lines are skipped (with a log entry) instead of
   * rewritten. Rewriting a multi-thousand-line file in one request is slow,
   * expensive and prone to truncation — small edits to huge files are common,
   * so skipping them is the pragmatic default. `0` disables the cap.
   * Default 2000.
   */
  maxFileLines: number;
  /** Max parallel rewrite API calls per audit. Default 3 */
  rewriteConcurrency: number;
  /** How to send content to the model: file, diff hunks, chunks, or auto. */
  rewriteScope: RewriteScopeMode;
  /** Files at or below this line count use full-file rewrite. Default 400 */
  rewriteFullFileBelowLines: number;
  /** Context lines around each diff hunk slice. Default 60 */
  contextLines: number;
  /** Max lines per chunk when rewriteScope is chunk. Default 450 */
  maxChunkLines: number;
  /** Reject rewrites that drop too many top-level declarations. Default true */
  structuralCheck: boolean;
}

export type RewriteScopeMode = "file" | "diff" | "chunk" | "auto";
export type EffectiveRewriteScope = "file" | "diff" | "chunk";

/** A threshold override that applies to files matching `pattern`. */
export interface ThresholdRule {
  pattern: string;
  value: number;
}

const DEFAULTS: BypasserConfig = {
  baseURL: "http://localhost:20128/v1",
  apiKey: "",
  model: "zd/claude-sonnet-4-5",
  threshold: 0.65,
  maxTokens: 16384,
  temperature: 0.4,
  ignore: [],
  thresholds: [],
  timeoutMs: 120000,
  timeoutPer1kLinesMs: 30000,
  maxTimeoutMs: 600000,
  maxFileLines: 2000,
  rewriteConcurrency: 3,
  rewriteScope: "auto",
  rewriteFullFileBelowLines: 400,
  contextLines: 60,
  maxChunkLines: 450,
  structuralCheck: true,
};

/** Built-in paths that should never be rewritten. */
export const BUILT_IN_IGNORE = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.lock",
  "dist/**",
  "build/**",
  ".next/**",
  "*.min.js",
  "*.min.css",
  "*.snap",
  "*.json",
  "*.yaml",
  "*.yml",
  "*.toml",
  // backups and tmp files from restageFile() — skip always
  "*.bak",
  "*.bypasser.tmp",
];

export function loadConfig(cwd = process.cwd()): BypasserConfig {
  const configPath = resolve(cwd, ".bypasser.json");
  let fileConfig: Partial<BypasserConfig> = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[bypasser] ⚠ Could not parse .bypasser.json (${reason}) — using defaults.`
      );
    }
  }

  // env vars win over file config
  const apiKey =
    process.env.BYPASSER_API_KEY ??
    process.env.OPENAI_API_KEY ??
    fileConfig.apiKey ??
    DEFAULTS.apiKey;

  const baseURL =
    process.env.BYPASSER_BASE_URL ?? fileConfig.baseURL ?? DEFAULTS.baseURL;

  const model =
    process.env.BYPASSER_MODEL ?? fileConfig.model ?? DEFAULTS.model;

  const threshold = fileConfig.threshold ?? DEFAULTS.threshold;
  const maxTokens = fileConfig.maxTokens ?? DEFAULTS.maxTokens;
  const temperature = fileConfig.temperature ?? DEFAULTS.temperature;
  const ignore = fileConfig.ignore ?? DEFAULTS.ignore;
  const thresholds = normalizeThresholdRules(fileConfig.thresholds);

  const timeoutMs = positiveNumber(fileConfig.timeoutMs, DEFAULTS.timeoutMs);
  const timeoutPer1kLinesMs = nonNegativeNumber(
    fileConfig.timeoutPer1kLinesMs,
    DEFAULTS.timeoutPer1kLinesMs
  );
  const maxTimeoutMs = positiveNumber(fileConfig.maxTimeoutMs, DEFAULTS.maxTimeoutMs);
  const maxFileLines = nonNegativeNumber(fileConfig.maxFileLines, DEFAULTS.maxFileLines);
  const rewriteConcurrency = positiveNumber(
    fileConfig.rewriteConcurrency,
    DEFAULTS.rewriteConcurrency
  );
  const rewriteScope = parseRewriteScope(fileConfig.rewriteScope, DEFAULTS.rewriteScope);
  const rewriteFullFileBelowLines = nonNegativeNumber(
    fileConfig.rewriteFullFileBelowLines,
    DEFAULTS.rewriteFullFileBelowLines
  );
  const contextLines = nonNegativeNumber(fileConfig.contextLines, DEFAULTS.contextLines);
  const maxChunkLines = positiveNumber(fileConfig.maxChunkLines, DEFAULTS.maxChunkLines);
  const structuralCheck =
    typeof fileConfig.structuralCheck === "boolean"
      ? fileConfig.structuralCheck
      : DEFAULTS.structuralCheck;

  return {
    baseURL,
    apiKey,
    model,
    threshold,
    maxTokens,
    temperature,
    ignore,
    thresholds,
    timeoutMs,
    timeoutPer1kLinesMs,
    maxTimeoutMs,
    maxFileLines,
    rewriteConcurrency,
    rewriteScope,
    rewriteFullFileBelowLines,
    contextLines,
    maxChunkLines,
    structuralCheck,
  };
}

function parseRewriteScope(val: unknown, fallback: RewriteScopeMode): RewriteScopeMode {
  if (val === "file" || val === "diff" || val === "chunk" || val === "auto") return val;
  return fallback;
}

/** Pick file / diff / chunk rewrite strategy for one staged file. */
export function resolveEffectiveRewriteScope(
  config: BypasserConfig,
  opts: { lineCount: number; changedLines: number; addedFraction: number }
): EffectiveRewriteScope {
  if (config.rewriteScope === "file") return "file";
  if (config.rewriteScope === "diff") return "diff";
  if (config.rewriteScope === "chunk") return "chunk";

  const { lineCount, changedLines, addedFraction } = opts;

  if (lineCount <= config.rewriteFullFileBelowLines) return "file";

  if (addedFraction >= 0.7 || changedLines >= lineCount * 0.5) {
    return "chunk";
  }

  // lineCount > rewriteFullFileBelowLines at this point
  return "diff";
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = numOr(value, fallback);
  return n > 0 ? n : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const n = numOr(value, fallback);
  return n >= 0 ? n : fallback;
}

/**
 * Effective rewrite timeout for a file of `lineCount` lines.
 * Base is `timeoutMs`; every full 1000 lines above 1000 adds `timeoutPer1kLinesMs`.
 * Clamped to `maxTimeoutMs`.
 */
export function scaledTimeoutMs(config: BypasserConfig, lineCount: number): number {
  const extraBlocks = Math.max(0, Math.floor((lineCount - 1000) / 1000));
  const scaled = config.timeoutMs + extraBlocks * config.timeoutPer1kLinesMs;
  return Math.min(scaled, config.maxTimeoutMs);
}

function normalizeThresholdRules(rules: unknown): ThresholdRule[] {
  if (!Array.isArray(rules)) return [];
  const out: ThresholdRule[] = [];
  for (const rule of rules) {
    if (
      rule &&
      typeof rule === "object" &&
      typeof (rule as ThresholdRule).pattern === "string" &&
      typeof (rule as ThresholdRule).value === "number"
    ) {
      out.push({
        pattern: (rule as ThresholdRule).pattern,
        value: (rule as ThresholdRule).value,
      });
    }
  }
  return out;
}

/**
 * First matching per-glob rule wins; falls back to global threshold.
 * `matchGlob` injected to avoid config → git import cycle.
 */
export function resolveThreshold(
  filePath: string,
  config: BypasserConfig,
  matchGlob: (path: string, pattern: string) => boolean
): number {
  for (const rule of config.thresholds) {
    if (matchGlob(filePath, rule.pattern)) return rule.value;
  }
  return config.threshold;
}