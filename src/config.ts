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
  /** File globs to always skip (on top of built-ins). */
  ignore: string[];
}


const DEFAULTS: BypasserConfig = {
  baseURL: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
  threshold: 0.65,
  maxTokens: 4096,
  ignore: [],
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
    } catch {
      // malformed config — continue with defaults
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
  const ignore = fileConfig.ignore ?? DEFAULTS.ignore;

  return { baseURL, apiKey, model, threshold, maxTokens, ignore };
}
