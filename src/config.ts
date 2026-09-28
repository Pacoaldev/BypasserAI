import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface BypasserConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 0–1. Diffs scoring above this threshold are sent for rewrite. Default 0.65 */
  threshold: number;
  /** Max tokens for the rewrite response. Default 4096 */
  maxTokens: number;
  /** Sampling temperature for the rewrite request. Default 0.4 */
  temperature: number;
  /** File globs to always skip (on top of built-ins). */
  ignore: string[];
  /** Per-glob threshold overrides. First matching pattern wins. */
  thresholds: ThresholdRule[];
}

/** A threshold override that applies to files matching `pattern`. */
export interface ThresholdRule {
  pattern: string;
  value: number;
}

const DEFAULTS: BypasserConfig = {
  baseURL: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
  threshold: 0.65,
  maxTokens: 4096,
  temperature: 0.4,
  ignore: [],
  thresholds: [],
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
];

export function loadConfig(cwd = process.cwd()): BypasserConfig {
  const configPath = resolve(cwd, ".bypasser.json");
  let fileConfig: Partial<BypasserConfig> = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      // Don't fail silently: a malformed config silently reverting to defaults
      // looks like "the tool does nothing". Surface it, keep running.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[bypasser] ⚠ Could not parse .bypasser.json (${reason}) — using defaults.`
      );
    }
  }

  // env vars override file config
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

  return { baseURL, apiKey, model, threshold, maxTokens, temperature, ignore, thresholds };
}

/** Validate the per-glob threshold rules, dropping malformed entries. */
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
 * Resolve the effective threshold for a given file path.
 * The first matching per-glob rule wins, otherwise the global threshold.
 * `matchGlob` is injected to avoid a config → git import cycle.
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
