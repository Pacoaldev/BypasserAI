import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { BypasserConfig, EffectiveRewriteScope } from "./config.js";
import {
  TRUNCATION_LINE_RATIO,
  TRUNCATION_MIN_LINES,
  COMPRESSION_LINE_RATIO,
  CHUNK_ASSEMBLY_LINE_RATIO,
} from "./rewrite-constants.js";
import {
  parseHunkRanges,
  mergeHunkRanges,
  sliceWithContext,
  spliceSlice,
} from "./diff-hunks.js";
import { splitIntoChunks } from "./chunk-split.js";
import { looksIndentBroken, looksStructurallyBroken, looksStubbed } from "./rewrite-validate.js";
import { checkSyntax } from "./syntax-guard.js";
import { resolveLanguage } from "./detector.js";
import { balanceRegressed } from "./bracket-balance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Why a model response was rejected and the original kept:
 *  - `truncated` — cut off / collapsed (token limit or lost tail)
 *  - `prose`     — chatbot preamble instead of raw code
 *  - `no-code`   — no recognisable code token
 *  - `indent`    — tokens are right but leading whitespace was flattened
 *  - `syntax`    — the assembled file does not parse under a real parser
 */
export type InvalidReason = "truncated" | "prose" | "no-code" | "indent" | "syntax";

/** Strip YAML frontmatter so only skill body reaches the model. */
function stripSkillFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("---", 3);
  if (end === -1) return raw;
  return raw.slice(end + 3).trimStart();
}

// Load humanizer skill from docs/SKILL.en.md (default) or docs/SKILL.es.md (BYPASSER_SKILL_LOCALE=es)
function loadSkillPrompt(): string {
  const locale = (process.env.BYPASSER_SKILL_LOCALE ?? "en").toLowerCase();
  const skillFile = locale.startsWith("es") ? "SKILL.es.md" : "SKILL.en.md";
  const roots = [resolve(__dirname, "../docs"), resolve(__dirname, "../../docs")];
  for (const root of roots) {
    const p = resolve(root, skillFile);
    if (existsSync(p)) return stripSkillFrontmatter(readFileSync(p, "utf8"));
  }
  // Legacy monolingual file (pre split en/es)
  for (const root of roots) {
    const legacy = resolve(root, "SKILL.md");
    if (!existsSync(legacy)) continue;
    const raw = readFileSync(legacy, "utf8");
    if (raw.includes("## Guidelines") || raw.includes("## Directrices")) {
      return stripSkillFrontmatter(raw);
    }
  }
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
Preserve the fragment's role in the file (same exports, signatures, and control flow).
Keep the **same indentation** as the input (leading spaces/tabs on each line). Do not drop lines unless they are narration comments you are intentionally removing.`;

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
  /\bpass\b/, /\braise\b/, /\bexcept\b/, /\belif\b/, /\basync\b/,
  /\bpublic\b/, /\bprivate\b/, /\bprotected\b/, /<\?php/,
];

/** True when `text` looks like source in the language of `filePath`. */
function looksLikeCode(text: string, filePath: string): boolean {
  if (CODE_TOKENS.some((re) => re.test(text))) return true;
  const p = resolveLanguage(filePath, text);
  if (p.id === "python") {
    return /\b(def|class|import|from|if|for|while|return|pass|raise|with|async|@)\b/.test(
      text
    );
  }
  if (p.id === "ruby") return /\b(def|class|module|end|require)\b/.test(text);
  if (p.id === "go") return /\b(func|package|type|struct|return)\b/.test(text);
  if (p.id === "rust") return /\b(fn|pub|struct|impl|enum|use)\b/.test(text);
  return false;
}

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
 *      which is approximate but sufficient as a signal). This is the strongest
 *      structural tell and always rejects.
 *   2. Line-count collapse — a cutoff on a clean statement boundary leaves no
 *      bracket imbalance, so a shrink is also suspicious.
 *
 * The shrink threshold depends on `finishReason`, because context matters:
 *
 *   - `finishReason === "length"` → the model ran out of tokens; the caller
 *     (`sanitizeResponse`) already rejects unconditionally before this runs.
 *   - `finishReason === "stop"` (a clean stop) → the model chose to end the
 *     response. A balanced-but-shorter rewrite is then very likely *legitimate
 *     compression* (the humanizer strips narration comments and terse
 *     docblocks, so a slop-heavy file can halve in size). We only reject a
 *     severe collapse (< `COMPRESSION_LINE_RATIO`), which is the rare cutoff
 *     landing exactly on a statement boundary.
 *   - any other / unknown finish reason → no signal from the API, so fall back
 *     to the stricter `TRUNCATION_LINE_RATIO`.
 *
 * `original` is the pre-rewrite content; the ratio is only meaningful for
 * files above `TRUNCATION_MIN_LINES`.
 */
export function looksTruncated(
  rewritten: string,
  original: string,
  finishReason?: string,
  filePath?: string
): boolean {
  // A structurally broken response is rejected regardless of finish reason.
  // The balance check is language-aware: `#` comments and Python docstrings
  // must not be scanned as code (see bracket-balance.ts). It fires only when the
  // rewrite is unbalanced *and the original was not* — otherwise an approximate
  // scanner's false positive on TSX/JSX (which the original shares) would reject
  // every rewrite of such a file.
  if (balanceRegressed(original, rewritten, resolveLanguage(filePath, rewritten))) return true;

  const originalLines = original.split("\n").length;
  if (originalLines < TRUNCATION_MIN_LINES) return false;
  const rewrittenLines = rewritten.split("\n").length;

  const ratio = finishReason === "stop" ? COMPRESSION_LINE_RATIO : TRUNCATION_LINE_RATIO;
  return rewrittenLines < originalLines * ratio;
}

/**
 * Line-collapse half of `looksTruncated` only — no bracket check.
 *
 * Used for diff/chunk *fragments*, whose line range is arbitrary and therefore
 * not expected to be bracket-balanced on its own. See `sanitizeResponse`.
 */
export function lineCollapseOnly(
  rewritten: string,
  original: string,
  finishReason?: string
): boolean {
  const originalLines = original.split("\n").length;
  if (originalLines < TRUNCATION_MIN_LINES) return false;
  const rewrittenLines = rewritten.split("\n").length;
  const ratio = finishReason === "stop" ? COMPRESSION_LINE_RATIO : TRUNCATION_LINE_RATIO;
  return rewrittenLines < originalLines * ratio;
}

/**
 * Diagnostic for a rejected rewrite: *why* `looksTruncated` flagged it.
 *
 * `looksTruncated` collapses two independent conditions into one boolean, so
 * its callers could only say "looks truncated" even when the line count had
 * actually *grown*. The two are very different failures (an unbalanced-bracket
 * assembly is usually a splice seam, not a token cutoff), so the log message
 * must name the real one.
 *
 * `isFragment` skips the bracket half for the same reason `sanitizeResponse`
 * does: an isolated slice is not expected to be bracket-balanced.
 *
 * Returns `null` when the rewrite is not flagged at all.
 */
export function truncationReason(
  rewritten: string,
  original: string,
  finishReason?: string,
  filePath?: string,
  isFragment = false
): "unbalanced-brackets" | "line-collapse" | null {
  if (
    !isFragment &&
    balanceRegressed(original, rewritten, resolveLanguage(filePath, rewritten))
  )
    return "unbalanced-brackets";

  const originalLines = original.split("\n").length;
  if (originalLines < TRUNCATION_MIN_LINES) return null;
  const rewrittenLines = rewritten.split("\n").length;
  const ratio = finishReason === "stop" ? COMPRESSION_LINE_RATIO : TRUNCATION_LINE_RATIO;
  return rewrittenLines < originalLines * ratio ? "line-collapse" : null;
}

// The balance scanner now lives in `bracket-balance.ts` (language-aware: it
// respects `#` comments and Python triple-quoted strings). See that module for
// why the old inline version rejected valid Python files as "truncated".

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
  finishReason?: string,
  isFragment = false
): { content: string; wasInvalid: boolean; reason?: InvalidReason } {
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

  // 1b. Drop a hallucinated "path header". The model occasionally prefixes the
  //     file body with the path it was given (`src/git.ts`) as a bare first
  //     line — never valid code, and it broke the build once by landing a
  //     stray identifier above the imports. We only strip a leading line that
  //     *exactly* matches the file path or its basename, so real code (which
  //     never IS the path) is untouched.
  const withoutPathHeader = stripPathHeader(stripped, filePath);

  // 2. Check the first 6 non-empty lines for prose signals
  const firstLines = withoutPathHeader
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);

  const hasProse = firstLines.some((line) =>
    PROSE_SIGNALS.some((re) => re.test(line))
  );

  // 3. Verify the response contains at least one recognisable code token
  const hasCode = looksLikeCode(withoutPathHeader, filePath);

  if (hasProse || !hasCode) {
    console.warn(
      `[bypasser] ⚠ Model returned a non-code response for ${filePath} — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: hasProse ? "prose" : "no-code" };
  }

  // 4. Completeness guard — reject a response cut short even when it *looks*
  //    like code. This is the guard that prevents the destructive truncation
  //    of a large file (see looksTruncated). `finishReason` is threaded through
  //    so a clean stop tolerates legitimate compression while an unknown end
  //    keeps the strict ratio.
  //
  //    `isFragment` skips the *bracket* half of the check: a diff/chunk slice is
  //    an arbitrary line range of the file, so it legitimately begins/ends
  //    mid-block with unbalanced brackets. Requiring zero imbalance there is the
  //    false positive that rejected valid rewrites of any large Python/JS file
  //    whose hunk cut inside a multi-line call — same reasoning as "do not parse
  //    isolated fragments" for `checkSyntax`. The assembled file is still
  //    bracket-checked as a whole in `validateAssembledFile`. The line-collapse
  //    half stays active (a fragment may not collapse beyond the ratio).
  const completenessFailed = isFragment
    ? lineCollapseOnly(withoutPathHeader, original, finishReason)
    : looksTruncated(withoutPathHeader, original, finishReason, filePath);
  if (completenessFailed) {
    const reason = truncationReason(
      withoutPathHeader,
      original,
      finishReason,
      filePath,
      isFragment
    );
    console.warn(
      `[bypasser] ⚠ Rewrite of ${filePath} rejected ` +
        `(${reason === "unbalanced-brackets" ? "unbalanced brackets" : "line collapse"}: ` +
        `${withoutPathHeader.split("\n").length} lines vs ${original.split("\n").length}) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "truncated" };
  }

  return { content: withoutPathHeader, wasInvalid: false };
}

/**
 * Remove a leading line that is just the file path (or its basename) — a
 * hallucinated header the model sometimes prepends to the body it returns.
 * Only an *exact* match is stripped, so no real first line of code is ever at
 * risk (a valid program does not begin with its own path). Also tolerates a
 * leading `File:` / `Path:` label on that same line.
 */
function stripPathHeader(code: string, filePath: string): string {
  const lines = code.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return code;

  const line = lines[firstIdx].trim();
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const candidates = new Set([filePath, base, `File: ${filePath}`, `Path: ${filePath}`]);

  if (!candidates.has(line)) return code;

  lines.splice(firstIdx, 1);
  // Drop a single blank line left behind, if any.
  if ((lines[firstIdx] ?? "").trim() === "") lines.splice(firstIdx, 1);
  return lines.join("\n");
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

/**
 * After chunk/diff assembly, a humanized file is often much shorter (comments
 * stripped). Treat the assembly like a clean model stop, not an unknown cutoff.
 */
const ASSEMBLY_FINISH: string = "stop";

function isSafePartialHumanization(
  original: string,
  working: string,
  filePath: string
): boolean {
  if (working.trim() === original.trim()) return false;
  if (balanceRegressed(original, working, resolveLanguage(filePath, working))) return false;
  const syntax = checkSyntax(working, filePath);
  if (syntax.status === "invalid") return false;
  return true;
}

function validateAssembledFile(
  original: string,
  assembled: string,
  filePath: string,
  config: BypasserConfig,
  minLineRatio = TRUNCATION_LINE_RATIO
): { content: string; wasInvalid: boolean; reason?: InvalidReason } {
  const oLines = original.split("\n").length;
  const aLines = assembled.split("\n").length;
  if (
    looksTruncated(assembled, original, ASSEMBLY_FINISH, filePath) ||
    (oLines >= TRUNCATION_MIN_LINES && aLines < oLines * minLineRatio)
  ) {
    const reason = truncationReason(assembled, original, ASSEMBLY_FINISH, filePath);
    const detail =
      reason === "unbalanced-brackets"
        ? "unbalanced brackets after chunk assembly"
        : reason === "line-collapse"
          ? "line collapse"
          : "shrank below the assembly ratio";
    console.warn(
      `[bypasser] ⚠ Assembled rewrite of ${filePath} rejected ` +
        `(${detail}: ${aLines} vs ${oLines} lines) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "truncated" };
  }
  // Backstop: a chunk assembly that flattens the file's indentation is rejected
  // as a whole even if each slice passed its own guard.
  if (looksIndentBroken(original, assembled)) {
    console.warn(
      `[bypasser] ⚠ Assembled rewrite of ${filePath} destroyed indentation — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "indent" };
  }
  // Definitive backstop: parse the fully assembled file with a real parser when
  // one is available. This is what catches a micro-misindentation (a single
  // line at the wrong level) that the conservative indent heuristic ignores —
  // the exact failure that produced an IndentationError in a large Python file.
  const syntax = checkSyntax(assembled, filePath);
  if (syntax.status === "invalid") {
    console.warn(
      `[bypasser] ⚠ Assembled rewrite of ${filePath} does not parse (${syntax.reason}) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "syntax" };
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
  minLineRatio = TRUNCATION_LINE_RATIO,
  isFragment = false
): { content: string; wasInvalid: boolean; reason?: InvalidReason } {
  const sanitized = sanitizeResponse(raw, original, filePath, finishReason, isFragment);
  if (sanitized.wasInvalid) return sanitized;

  // Stub guard: a response that carries an explicit "N lines omitted" marker is
  // a truncated body the model stubbed out, not a rewrite. No real source
  // contains such a banner, so this is a zero-false-positive rejection of the
  // corruption that `zd/claude-sonnet-4-5` produced on Python (replacing a real
  // `return [...]`/`raise` with `# [1 lines omitted]` + `pass`) — which parses
  // and passes every other guard, yet silently breaks the code.
  if (looksStubbed(sanitized.content)) {
    console.warn(
      `[bypasser] ⚠ Rewrite of ${filePath} stubbed out code ("lines omitted" marker) — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "truncated" };
  }

  // `sanitizeResponse` already ran the completeness guard with the
  // finish-reason-aware threshold. Only re-check when the caller requests a
  // *stricter* ratio than that (chunk assembly, which must not shrink more
  // than CHUNK_ASSEMBLY_LINE_RATIO across spliced fragments). Re-applying the
  // default ratio here would re-reject legitimate compression.
  if (minLineRatio > TRUNCATION_LINE_RATIO) {
    const origLines = original.split("\n").length;
    const newLines = sanitized.content.split("\n").length;
    if (origLines >= TRUNCATION_MIN_LINES && newLines < origLines * minLineRatio) {
      console.warn(
        `[bypasser] ⚠ Rewrite of ${filePath} looks truncated (${newLines} vs ${origLines} lines) — keeping original.`
      );
      return { content: original, wasInvalid: true, reason: "truncated" };
    }
  }

  // Fragment-level indentation guard: a slice whose leading whitespace was
  // flattened is rejected so the caller keeps the original lines for that
  // range instead of splicing in mis-indented code.
  if (looksIndentBroken(original, sanitized.content)) {
    console.warn(
      `[bypasser] ⚠ Rewrite of ${filePath} destroyed indentation — keeping original.`
    );
    return { content: original, wasInvalid: true, reason: "indent" };
  }

  const structural = applyStructuralCheck(original, sanitized.content, filePath, config);
  if (!structural.ok) {
    return { content: original, wasInvalid: true, reason: structural.reason };
  }
  return sanitized;
}

function effectiveMaxTokens(config: BypasserConfig, userMessage: string): number {
  const lines = userMessage.split("\n").length;
  // Headroom for rewrites that expand slightly; cap at config.maxTokens.
  const scaled = Math.ceil(lines * 14);
  return Math.min(config.maxTokens, Math.max(4096, scaled));
}

async function callModel(
  client: RewriteClient,
  config: BypasserConfig,
  systemPrompt: string,
  userMessage: string
): Promise<{ raw: string; finishReason?: string }> {
  let maxTokens = effectiveMaxTokens(config, userMessage);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: maxTokens,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: config.temperature,
    });
    const finishReason = response.choices[0]?.finish_reason ?? undefined;
    const raw = response.choices[0]?.message?.content ?? "";
    if (finishReason !== "length" || attempt === 1) {
      return { raw, finishReason };
    }
    maxTokens = Math.min(Math.max(Math.floor(maxTokens * 1.75), config.maxTokens), 65536);
    console.warn(
      `[bypasser] ⚠ Model hit token limit — retrying with max_tokens=${maxTokens}.`
    );
  }
  return { raw: "", finishReason: "length" };
}

function finishChunkOrDiffRewrite(
  content: string,
  working: string,
  filePath: string,
  config: BypasserConfig,
  anyChange: boolean,
  minLineRatio: number
): RewriteResult {
  const whole = validateAssembledFile(content, working, filePath, config, minLineRatio);
  if (!whole.wasInvalid) {
    return {
      rewritten: whole.content,
      changed: anyChange && whole.content.trim() !== content.trim(),
      hash: anyChange ? contentHash(whole.content) : contentHash(content),
    };
  }

  if (anyChange && isSafePartialHumanization(content, working, filePath)) {
    console.warn(
      `[bypasser] ⚠ Assembly checks failed for ${filePath} (${whole.reason ?? "invalid"}) ` +
        `but partial rewrite parses — keeping humanized slices.`
    );
    return {
      rewritten: working,
      changed: true,
      hash: contentHash(working),
    };
  }

  return {
    rewritten: content,
    changed: false,
    sanitizerWarning: true,
    invalidReason: whole.reason,
  };
}

export interface RewriteResult {
  rewritten: string;
  changed: boolean;
  sanitizerWarning?: boolean;
  /** Why the response was rejected, when `sanitizerWarning` is set. */
  invalidReason?: InvalidReason;
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
  // Full-file rewrites are a complete, standalone source — safe to parse as a
  // whole. A file that fails to parse must never replace the original.
  if (!wasInvalid) {
    const syntax = checkSyntax(rewritten, filePath);
    if (syntax.status === "invalid") {
      console.warn(
        `[bypasser] ⚠ Rewrite of ${filePath} does not parse (${syntax.reason}) — keeping original.`
      );
      return {
        rewritten: content,
        changed: false,
        sanitizerWarning: true,
        invalidReason: "syntax",
      };
    }
  }
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
      config,
      TRUNCATION_LINE_RATIO,
      true
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

  return finishChunkOrDiffRewrite(
    content,
    working,
    filePath,
    config,
    anyChange,
    TRUNCATION_LINE_RATIO
  );
}

async function rewriteByChunksInner(
  client: RewriteClient,
  filePath: string,
  content: string,
  config: BypasserConfig,
  maxChunkLines: number
): Promise<RewriteResult> {
  const chunks = splitIntoChunks(content, filePath, maxChunkLines).sort(
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
      config,
      TRUNCATION_LINE_RATIO,
      true
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

  return finishChunkOrDiffRewrite(
    content,
    working,
    filePath,
    config,
    anyChange,
    CHUNK_ASSEMBLY_LINE_RATIO
  );
}

async function rewriteByChunks(
  client: RewriteClient,
  filePath: string,
  content: string,
  config: BypasserConfig
): Promise<RewriteResult> {
  let result = await rewriteByChunksInner(
    client,
    filePath,
    content,
    config,
    config.maxChunkLines
  );
  const smaller = Math.max(120, Math.floor(config.maxChunkLines / 2));
  if (!result.changed && !result.skipped && smaller < config.maxChunkLines) {
    console.warn(
      `[bypasser] ⚠ Chunk rewrite did not stick for ${filePath} — retrying with maxChunkLines=${smaller}.`
    );
    result = await rewriteByChunksInner(client, filePath, content, config, smaller);
  }
  return result;
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
