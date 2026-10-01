import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { BypasserConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the humanizer skill prompt from docs/SKILL.md
function loadSkillPrompt(): string {
  // resolve relative to the package root (one level up from src/dist)
  const candidates = [
    resolve(__dirname, "../docs/SKILL.md"),
    resolve(__dirname, "../../docs/SKILL.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  // fallback: inline minimal version so the tool never breaks
  return `You are a code humanizer. Rewrite AI-generated code so it reads as written by an intermediate human developer. Apply subtle naming variations, mix control flow styles, comment sparingly in natural tone, and avoid RLHF-polished patterns. Never degrade correctness, security, or readability.`;
}

const SYSTEM_PROMPT = `You are a code humanizer working on a git diff.

${loadSkillPrompt()}

## Task
You will receive a file path and its full current content (after staged changes).
Rewrite the content applying the humanizer skill above.

## Output format
Return ONLY the rewritten file content — no explanations, no markdown fences, no preamble.
The output must be valid, compilable code in the same language as the input.
If the code already looks human enough, return it UNCHANGED.`;

// Prose signals that indicate the model responded as a chatbot instead of
// returning raw code. We check the first few lines where preamble appears.
const PROSE_SIGNALS = [
  /^i notice\b/i,
  /^i see\b/i,
  /^here (are|is)\b/i,
  /^let me\b/i,
  /^sure[,!.]/i,
  /^of course/i,
  /^this (file|code|function|snippet)\b/i,
  /^the (file|code|function|snippet)\b/i,
  /^\d+\.\s+\*\*/,      // numbered markdown list like "1. **Remove the…"
  /^-\s+\*\*/,           // bullet markdown like "- **Remove the…"
];

// Minimal set of tokens that must appear somewhere in a valid code response.
const CODE_TOKENS = [
  /\bimport\b/, /\bexport\b/, /\bfunction\b/, /\bconst\b/, /\blet\b/,
  /\bvar\b/, /\bclass\b/, /\breturn\b/, /\bdef\b/, /\bfunc\b/,
  /^#!/, /^package\s/, /^using\s/,
];

/**
 * Below this fraction of the original line count a rewrite is treated as a
 * silent truncation. A humanizer must not *delete* large parts of a file: a
 * legitimate rewrite changes wording and structure but keeps essentially the
 * same line count. 0.75 gives generous headroom for reformatting (collapsing
 * blank lines, inlining) while still catching a token-limit cutoff, which
 * typically lands far below it.
 */
const TRUNCATION_LINE_RATIO = 0.75;

/**
 * Below this absolute line count we do not apply the ratio test: tiny files
 * legitimately change size a lot, and a single line removed from a 3-line file
 * must not be read as truncation.
 */
const TRUNCATION_MIN_LINES = 12;

/**
 * Detect a response that was cut off before the file was fully rewritten.
 *
 * This is the guard against the incident where `providers.rs` was truncated
 * from ~2570 to 474 lines: the model hit `max_tokens`, the response passed the
 * (then prose/token-only) sanitizer, and the truncated content was restaged
 * over the original. Two independent conditions flag truncation:
 *
 *   1. Bracket imbalance — the cutoff usually lands mid-block, leaving
 *      unbalanced `{}`/`()`/`[]` (ignoring matches inside strings/comments,
 *      which is approximate but sufficient as a signal).
 *   2. Line-count collapse — even a cutoff on a clean statement boundary is
 *      caught when the result is under `TRUNCATION_LINE_RATIO` of the original.
 *
 * `original` is the pre-rewrite content; the ratio is only meaningful for
 * files above `TRUNCATION_MIN_LINES`.
 */
export function looksTruncated(rewritten: string, original: string): boolean {
  const originalLines = original.split("\n").length;
  const rewrittenLines = rewritten.split("\n").length;

  if (originalLines >= TRUNCATION_MIN_LINES) {
    if (rewrittenLines < originalLines * TRUNCATION_LINE_RATIO) return true;
  }

  return hasUnbalancedBrackets(rewritten);
}

/** Rough bracket-balance check outside of string literals and line comments. */
function hasUnbalancedBrackets(code: string): boolean {
  const stack: string[] = [];
  const closing: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  const opening = new Set(["{", "(", "["]);

  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let backtick = false;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") i++;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (backtick) {
      if (ch === "\\") i++;
      else if (ch === "`") backtick = false;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      backtick = true;
      continue;
    }

    if (opening.has(ch)) {
      stack.push(ch);
    } else if (ch in closing) {
      if (stack.length === 0 || stack[stack.length - 1] !== closing[ch]) {
        // A closer with no matching opener — structurally broken.
        return true;
      }
      stack.pop();
    }
  }

  // Anything left open means the file was cut off mid-block.
  return stack.length > 0;
}

/**
 * Strip markdown code fences and detect chatbot-style prose responses.
 *
 * Returns the sanitized content, a flag indicating whether the model produced
 * an invalid (non-code or truncated) response, and — when invalid — the reason
 * so the caller/log can say *why* the original was kept.
 *
 * `finishReason` is the OpenAI `finish_reason` for the response. When it is
 * `"length"` the model ran out of tokens and the response is definitionally
 * incomplete, so we reject it before any content check.
 */
export function sanitizeResponse(
  raw: string,
  original: string,
  filePath: string,
  finishReason?: string
): { content: string; wasInvalid: boolean; reason?: "truncated" | "prose" | "no-code" } {
  // 0. A `length` finish reason means the model was cut off mid-generation.
  //    Never trust the content — it is missing an unknown amount of the tail.
  if (finishReason === "length") {
    console.warn(
      `[bypasser] ⚠ Model hit the token limit for ${filePath} (finish_reason=length) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "truncated" };
  }

  // 1. Strip leading/trailing markdown fences (```lang … ``` or ~~~ … ~~~)
  const fenceRe = /^(?:```[\w]*|~~~[\w]*)\r?\n([\s\S]*?)(?:```|~~~)\s*$/;
  const fenceMatch = raw.trim().match(fenceRe);
  const stripped = fenceMatch ? fenceMatch[1] : raw;

  // 2. Check the first 6 non-empty lines for prose signals
  const firstLines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);

  const hasProse = firstLines.some((line) =>
    PROSE_SIGNALS.some((re) => re.test(line))
  );

  // 3. Verify the response contains at least one recognisable code token
  const hasCode = CODE_TOKENS.some((re) => re.test(stripped));

  if (hasProse || !hasCode) {
    console.warn(
      `[bypasser] ⚠ Model returned a non-code response for ${filePath} — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: hasProse ? "prose" : "no-code" };
  }

  // 4. Completeness guard — reject a response cut short even when it *looks*
  //    like code. This is the guard that prevents the destructive truncation
  //    of a large file (see looksTruncated).
  if (looksTruncated(stripped, original)) {
    console.warn(
      `[bypasser] ⚠ Rewrite of ${filePath} looks truncated ` +
        `(${stripped.split("\n").length} lines vs ${original.split("\n").length}) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "truncated" };
  }

  return { content: stripped, wasInvalid: false };
}

export interface RewriteResult {
  rewritten: string;
  changed: boolean;
  sanitizerWarning?: boolean;
  /** Why the response was rejected, when `sanitizerWarning` is set. */
  invalidReason?: "truncated" | "prose" | "no-code";
  /** True when the content hash matched a previous successful rewrite. */
  skipped?: boolean;
  /** Content hash, exposed so callers can persist it. */
  hash?: string;
}

/** Stable content hash used to skip re-rewriting identical content. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function rewriteFile(
  filePath: string,
  content: string,
  config: BypasserConfig,
  options: {
    /** If this hash equals the content hash, skip the API call entirely. */
    knownHash?: string;
    /** Per-request timeout in ms. Default 60000. */
    timeout?: number;
    /** Retries for transient API errors (429/5xx). Default 2. */
    maxRetries?: number;
  } = {}
): Promise<RewriteResult> {
  const hash = contentHash(content);

  // Already humanized this exact content before — don't pay for it twice.
  if (options.knownHash && options.knownHash === hash) {
    return { rewritten: content, changed: false, skipped: true, hash };
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: options.timeout ?? 60000,
    maxRetries: options.maxRetries ?? 2,
  });

  const userMessage = `File: ${filePath}\n\n${content}`;

  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: config.temperature,
  });

  const raw = response.choices[0]?.message?.content ?? content;
  const finishReason = response.choices[0]?.finish_reason ?? undefined;
  const { content: rewritten, wasInvalid, reason } = sanitizeResponse(
    raw,
    content,
    filePath,
    finishReason
  );
  const changed = rewritten.trim() !== content.trim();

  // Only remember the hash of a *successful, non-invalid* rewrite so a failed
  // response is retried on the next commit.
  return {
    rewritten,
    changed,
    sanitizerWarning: wasInvalid,
    invalidReason: wasInvalid ? reason : undefined,
    hash: wasInvalid ? undefined : contentHash(rewritten),
  };
}
