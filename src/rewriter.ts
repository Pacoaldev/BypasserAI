import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { BypasserConfig, EffectiveRewriteScope } from "./config.js";
import {
  TRUNCATION_LINE_RATIO,
  TRUNCATION_MIN_LINES,
  CHUNK_ASSEMBLY_LINE_RATIO,
} from "./rewrite-constants.js";
import {
  parseHunkRanges,
  mergeHunkRanges,
  sliceWithContext,
  spliceSlice,
} from "./diff-hunks.js";
import { splitIntoChunks } from "./chunk-split.js";
import { looksStructurallyBroken } from "./rewrite-validate.js";

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

const FRAGMENT_SYSTEM = `${SYSTEM_PROMPT}

## Fragment mode
You receive a **fragment** of a larger file with 1-based line numbers START–END.
Rewrite only this fragment. Return **only** the rewritten fragment text — no fences, no path, no explanation.
Preserve the fragment's role in the file (same exports, signatures, and control flow).`;

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

export type RewriteClient = OpenAI;

export function createRewriteClient(
  config: BypasserConfig,
  timeoutMs: number,
  maxRetries = 2
): RewriteClient {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: timeoutMs,
    maxRetries,
  });
}

function applyStructuralCheck(
  original: string,
  candidate: string,
  filePath: string,
  config: BypasserConfig
): { ok: boolean; reason?: "truncated" } {
  if (!config.structuralCheck) return { ok: true };
  if (looksStructurallyBroken(original, candidate, filePath)) {
    console.warn(
      `[bypasser] ⚠ Rewrite of ${filePath} dropped too many declarations — keeping original.`
    );
    return { ok: false, reason: "truncated" };
  }
  return { ok: true };
}

function validateAssembledFile(
  original: string,
  assembled: string,
  filePath: string,
  config: BypasserConfig,
  minLineRatio = TRUNCATION_LINE_RATIO
): { content: string; wasInvalid: boolean; reason?: "truncated" | "prose" | "no-code" } {
  const oLines = original.split("\n").length;
  const aLines = assembled.split("\n").length;
  if (
    looksTruncated(assembled, original) ||
    (oLines >= TRUNCATION_MIN_LINES && aLines < oLines * minLineRatio)
  ) {
    console.warn(
      `[bypasser] ⚠ Assembled rewrite of ${filePath} looks truncated (${aLines} vs ${oLines}) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "truncated" };
  }
  const structural = applyStructuralCheck(original, assembled, filePath, config);
  if (!structural.ok) {
    return { content: original, wasInvalid: true, reason: structural.reason };
  }
  return { content: assembled, wasInvalid: false };
}

function finalizeRewrite(
  original: string,
  raw: string,
  filePath: string,
  finishReason: string | undefined,
  config: BypasserConfig,
  minLineRatio = TRUNCATION_LINE_RATIO
): { content: string; wasInvalid: boolean; reason?: "truncated" | "prose" | "no-code" } {
  const sanitized = sanitizeResponse(raw, original, filePath, finishReason);
  if (sanitized.wasInvalid) return sanitized;

  const origLines = original.split("\n").length;
  const newLines = sanitized.content.split("\n").length;
  if (origLines >= TRUNCATION_MIN_LINES && newLines < origLines * minLineRatio) {
    console.warn(
      `[bypasser] ⚠ Rewrite of ${filePath} looks truncated (${newLines} vs ${origLines} lines) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "truncated" };
  }

  const structural = applyStructuralCheck(original, sanitized.content, filePath, config);
  if (!structural.ok) {
    return { content: original, wasInvalid: true, reason: structural.reason };
  }
  return sanitized;
}

async function callModel(
  client: RewriteClient,
  config: BypasserConfig,
  systemPrompt: string,
  userMessage: string
): Promise<{ raw: string; finishReason?: string }> {
  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: config.temperature,
  });
  return {
    raw: response.choices[0]?.message?.content ?? "",
    finishReason: response.choices[0]?.finish_reason ?? undefined,
  };
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

async function rewriteFullFile(
  client: RewriteClient,
  filePath: string,
  content: string,
  config: BypasserConfig
): Promise<RewriteResult> {
  const userMessage = `File: ${filePath}\n\n${content}`;
  const { raw, finishReason } = await callModel(client, config, SYSTEM_PROMPT, userMessage);
  const { content: rewritten, wasInvalid, reason } = finalizeRewrite(
    content,
    raw || content,
    filePath,
    finishReason,
    config
  );
  const changed = rewritten.trim() !== content.trim();
  return {
    rewritten,
    changed,
    sanitizerWarning: wasInvalid,
    invalidReason: wasInvalid ? reason : undefined,
    hash: wasInvalid ? undefined : contentHash(rewritten),
  };
}

async function rewriteByDiff(
  client: RewriteClient,
  filePath: string,
  content: string,
  diff: string,
  config: BypasserConfig
): Promise<RewriteResult> {
  const ranges = mergeHunkRanges(parseHunkRanges(diff), 8).sort(
    (a, b) => b.newStart - a.newStart
  );
  if (ranges.length === 0) {
    return rewriteFullFile(client, filePath, content, config);
  }

  let working = content;
  let anyChange = false;

  for (const range of ranges) {
    const { slice, startLine, endLine } = sliceWithContext(
      working,
      range,
      config.contextLines
    );
    const userMessage =
      `File: ${filePath}\nFragment lines ${startLine}-${endLine} (inclusive):\n\n${slice}`;
    const { raw, finishReason } = await callModel(
      client,
      config,
      FRAGMENT_SYSTEM,
      userMessage
    );
    const sliceOriginal = working
      .split("\n")
      .slice(startLine - 1, endLine)
      .join("\n");
    const { content: newSlice, wasInvalid } = finalizeRewrite(
      sliceOriginal,
      raw,
      filePath,
      finishReason,
      config
    );
    if (wasInvalid) {
      console.warn(
        `[bypasser] ⚠ Hunk ${startLine}-${endLine} in ${filePath} rejected — keeping original slice.`
      );
      continue;
    }
    if (newSlice.trim() !== sliceOriginal.trim()) {
      working = spliceSlice(working, startLine, endLine, newSlice);
      anyChange = true;
    }
  }

  const whole = validateAssembledFile(content, working, filePath, config);
  if (whole.wasInvalid) {
    return {
      rewritten: content,
      changed: false,
      sanitizerWarning: true,
      invalidReason: whole.reason,
    };
  }

  return {
    rewritten: whole.content,
    changed: anyChange && whole.content.trim() !== content.trim(),
    hash: anyChange ? contentHash(whole.content) : contentHash(content),
  };
}

async function rewriteByChunks(
  client: RewriteClient,
  filePath: string,
  content: string,
  config: BypasserConfig
): Promise<RewriteResult> {
  const chunks = splitIntoChunks(content, filePath, config.maxChunkLines).sort(
    (a, b) => b.startLine - a.startLine
  );
  let working = content;
  let anyChange = false;

  for (const chunk of chunks) {
    const userMessage = `File: ${filePath}\nFragment lines ${chunk.startLine}-${chunk.endLine} (inclusive):\n\n${chunk.text}`;
    const { raw, finishReason } = await callModel(
      client,
      config,
      FRAGMENT_SYSTEM,
      userMessage
    );
    const sliceOriginal = working
      .split("\n")
      .slice(chunk.startLine - 1, chunk.endLine)
      .join("\n");
    const { content: newSlice, wasInvalid } = finalizeRewrite(
      sliceOriginal,
      raw,
      filePath,
      finishReason,
      config
    );
    if (wasInvalid) {
      console.warn(
        `[bypasser] ⚠ Chunk ${chunk.startLine}-${chunk.endLine} in ${filePath} rejected — keeping original.`
      );
      continue;
    }
    if (newSlice.trim() !== sliceOriginal.trim()) {
      working = spliceSlice(working, chunk.startLine, chunk.endLine, newSlice);
      anyChange = true;
    }
  }

  const whole = validateAssembledFile(
    content,
    working,
    filePath,
    config,
    CHUNK_ASSEMBLY_LINE_RATIO
  );
  if (whole.wasInvalid) {
    return {
      rewritten: content,
      changed: false,
      sanitizerWarning: true,
      invalidReason: whole.reason,
    };
  }

  return {
    rewritten: whole.content,
    changed: anyChange && whole.content.trim() !== content.trim(),
    hash: anyChange ? contentHash(whole.content) : contentHash(content),
  };
}

export async function rewriteFile(
  filePath: string,
  content: string,
  config: BypasserConfig,
  options: {
    knownHash?: string;
    timeout?: number;
    maxRetries?: number;
    client?: RewriteClient;
    scope?: EffectiveRewriteScope;
    diff?: string;
  } = {}
): Promise<RewriteResult> {
  const hash = contentHash(content);

  if (options.knownHash && options.knownHash === hash) {
    return { rewritten: content, changed: false, skipped: true, hash };
  }

  const client =
    options.client ??
    createRewriteClient(config, options.timeout ?? 120000, options.maxRetries ?? 2);

  const scope = options.scope ?? "file";

  let result: RewriteResult;
  if (scope === "diff" && options.diff) {
    result = await rewriteByDiff(client, filePath, content, options.diff, config);
  } else if (scope === "chunk") {
    result = await rewriteByChunks(client, filePath, content, config);
  } else {
    result = await rewriteFullFile(client, filePath, content, config);
  }

  if (result.hash === undefined && !result.sanitizerWarning && result.changed) {
    result.hash = contentHash(result.rewritten);
  }
  return result;
}
