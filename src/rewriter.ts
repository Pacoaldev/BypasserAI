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
 * Strip markdown code fences and detect chatbot-style prose responses.
 * Returns the sanitized content and a flag indicating whether the model
 * produced an invalid (non-code) response so the caller can fall back.
 */
function sanitizeResponse(
  raw: string,
  original: string,
  filePath: string
): { content: string; wasInvalid: boolean } {
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
    return { content: original, wasInvalid: true };
  }

  return { content: stripped, wasInvalid: false };
}

export interface RewriteResult {
  rewritten: string;
  changed: boolean;
  sanitizerWarning?: boolean;
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
  const { content: rewritten, wasInvalid } = sanitizeResponse(raw, content, filePath);
  const changed = rewritten.trim() !== content.trim();

  // Only remember the hash of a *successful, non-invalid* rewrite so a failed
  // response is retried on the next commit.
  return {
    rewritten,
    changed,
    sanitizerWarning: wasInvalid,
    hash: wasInvalid ? undefined : contentHash(rewritten),
  };
}
