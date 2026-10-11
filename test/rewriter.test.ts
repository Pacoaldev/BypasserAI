import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeResponse,
  looksTruncated,
  truncationReason,
  rewriteFile,
  lineCollapseOnly,
  fragmentLengthChanged,
} from "../src/rewriter.js";
import type { RewriteClient } from "../src/rewriter.js";

/** Minimal mock client that returns a fixed completion for the next call. */
function mockClient(contents: string[]): RewriteClient {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: { content: contents[Math.min(i++, contents.length - 1)] },
              finish_reason: "stop",
            },
          ],
        }),
      },
    },
  } as unknown as RewriteClient;
}

const configStub = {
  model: "test",
  maxTokens: 4096,
  temperature: 0,
  maxChunkLines: 450,
  contextLines: 20,
  structuralCheck: true,
  rewriteScope: "file",
} as unknown as Parameters<typeof rewriteFile>[2];

// ---------------------------------------------------------------------------
// Regression suite for the destructive-truncation incident.
//
// Incident: the pre-commit hook rewrote `providers.rs` and truncated it from
// ~2570 to 474 lines. The model's response was cut off at `max_tokens`, but
// the old sanitizer only checked (a) markdown fences, (b) chatbot prose in the
// first 6 lines, and (c) that *some* code token existed. A truncated file
// passed all three, so it was restaged over the original — silently destroying
// ~2000 lines.
//
// These tests lock the completeness guard so a truncated response can never be
// accepted as valid again.
// ---------------------------------------------------------------------------

// A realistic "original" file: 200+ lines, balanced braces/parens.
function bigOriginal(): string {
  const lines: string[] = [];
  lines.push("use std::collections::HashMap;");
  lines.push("");
  lines.push("pub struct ProviderChecker {");
  lines.push("    pub name: String,");
  lines.push("    pub enabled: bool,");
  lines.push("}");
  for (let i = 0; i < 100; i++) {
    lines.push("");
    lines.push(`pub fn handler_${i}(input: &str) -> Result<String, Error> {`);
    lines.push(`    let trimmed = input.trim();`);
    lines.push(`    if trimmed.is_empty() {`);
    lines.push(`        return Err(Error::Empty);`);
    lines.push(`    }`);
    lines.push(`    Ok(trimmed.to_string())`);
    lines.push(`}`);
  }
  return lines.join("\n") + "\n";
}

test("looksTruncated: a response cut at max_tokens is detected", () => {
  const original = bigOriginal();
  // Take the first ~20% of the file, exactly what a token-limit cutoff yields.
  const truncated = original.split("\n").slice(0, 60).join("\n");
  assert.equal(looksTruncated(truncated, original), true);
});

test("looksTruncated: a full, complete rewrite is NOT flagged", () => {
  const original = bigOriginal();
  // Same structure, slightly reworded — should pass.
  const rewritten = original.replace(/handler_/g, "process_").replace(/trimmed/g, "cleaned");
  assert.equal(looksTruncated(rewritten, original), false);
});

test("looksTruncated: balanced but wildly shorter output is flagged", () => {
  // Unbalanced-free but only ~10% of the original length: classic silent
  // truncation that ends on a clean statement boundary.
  const original = "a\n".repeat(200);
  const shortened = "a\n".repeat(10);
  assert.equal(looksTruncated(shortened, original), true);
});

test("looksTruncated: unbalanced braces are flagged", () => {
  const original = "function f() {\n  return 1;\n}\n".repeat(30);
  const balanced = "function f() {\n  return 1;\n}\n".repeat(30);
  assert.equal(looksTruncated(balanced, original), false);
  // Drop the final closing brace → unbalanced → truncated.
  const unbalanced = balanced.trimEnd().slice(0, -1);
  assert.equal(looksTruncated(unbalanced, original), true);
});

// ---------------------------------------------------------------------------
// truncationReason — distinguish *why* a rewrite was flagged.
//
// The old message said "looks truncated" even when the line count had grown
// (a splice seam with unbalanced brackets). These tests pin the diagnosis so
// the log names the real failure.
// ---------------------------------------------------------------------------

test("truncationReason: unbalanced brackets are named as such", () => {
  const original = "function f() {\n  return 1;\n}\n".repeat(30);
  const unbalanced = original.trimEnd().slice(0, -1); // drop final closing brace
  assert.equal(truncationReason(unbalanced, original), "unbalanced-brackets");
});

test("truncationReason: a balanced but collapsed body is a line collapse", () => {
  const original = "a\n".repeat(200);
  const shortened = "a\n".repeat(10);
  assert.equal(truncationReason(shortened, original), "line-collapse");
});

test("truncationReason: a longer but unbalanced assembly is NOT a line collapse", () => {
  // The real incident: the assembled file grew (2872 vs 2865 lines) yet was
  // flagged. The reason must say "unbalanced-brackets", never "truncated".
  const original = "function f() {\n  return 1;\n}\n".repeat(30);
  const grown = original + "function g() {\n  return 2;\n\n"; // extra open block
  const grownLines = grown.split("\n").length;
  const origLines = original.split("\n").length;
  assert.ok(grownLines > origLines, "fixture must be longer than the original");
  assert.equal(truncationReason(grown, original), "unbalanced-brackets");
});

test("truncationReason: a clean, balanced rewrite returns null", () => {
  const original = "function f() {\n  return 1;\n}\n".repeat(30);
  const rewritten = original.replace(/f\(/g, "handler(");
  assert.equal(truncationReason(rewritten, original), null);
});

test("truncationReason: small file below the min-lines floor returns null", () => {
  const original = "a\nb\nc\n"; // < TRUNCATION_MIN_LINES
  assert.equal(truncationReason("a\n", original), null);
});

// ---------------------------------------------------------------------------
// Compression vs truncation — the finish-reason-aware threshold.
//
// The humanizer legitimately shrinks a slop-heavy file by stripping narration
// comments and terse docblocks; that is its whole job. The old flat 0.75 ratio
// rejected such rewrites as "truncated" even when the model stopped cleanly and
// the code was complete and balanced. These tests pin the distinction: a clean
// stop tolerates real compression, but a severe collapse or a broken structure
// is still rejected no matter what.
// ---------------------------------------------------------------------------

/** A file padded with narration so a rewrite can legitimately halve it. */
function slopPaddedOriginal(): string {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push(`// Validate input number ${i}`);
    lines.push(`export function processItem${i}(value: number): number {`);
    lines.push(`  // Make sure the value is present`);
    lines.push(`  if (!value) {`);
    lines.push(`    throw new Error("value required");`);
    lines.push(`  }`);
    lines.push(`  // Return the value`);
    lines.push(`  return value;`);
    lines.push(`}`);
    lines.push(``);
  }
  return lines.join("\n") + "\n";
}

test("looksTruncated: a clean stop tolerates legitimate compression (~50%)", () => {
  const original = slopPaddedOriginal();
  // The humanizer drops the narration comments → roughly half the lines, but
  // the code is complete and balanced. finish_reason=stop must accept it.
  const compressed = original
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const ratio = compressed.split("\n").length / original.split("\n").length;
  assert.ok(ratio < 0.75 && ratio > 0.4, `fixture should sit in the tolerant band, got ${ratio}`);
  assert.equal(looksTruncated(compressed, original, "stop"), false);
});

test("looksTruncated: a severe collapse is rejected even on a clean stop", () => {
  // A cutoff landing exactly on a statement boundary leaves balanced brackets;
  // the low floor still catches it. 10% is far below COMPRESSION_LINE_RATIO.
  const original = slopPaddedOriginal();
  const tiny = original.split("\n").slice(0, Math.floor(original.split("\n").length * 0.1)).join("\n");
  assert.equal(looksTruncated(tiny, original, "stop"), true);
});

test("looksTruncated: an unknown finish reason keeps the strict ratio", () => {
  const original = slopPaddedOriginal();
  const compressed = original
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // No finish reason → no signal from the API → strict 0.75 threshold applies,
  // so the same content that a clean stop accepts is rejected here.
  assert.equal(looksTruncated(compressed, original, undefined), true);
});

test("looksTruncated: unbalanced brackets reject regardless of a clean stop", () => {
  const original = slopPaddedOriginal();
  const compressed = original
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // Drop the final closing brace → structurally broken → rejected even though
  // the finish reason is a clean stop.
  const trimmed = compressed.trimEnd();
  const unbalanced = trimmed.slice(0, trimmed.lastIndexOf("}")) + trimmed.slice(trimmed.lastIndexOf("}") + 1);
  assert.equal(looksTruncated(unbalanced, original, "stop"), true);
});

test("sanitizeResponse: a clean-stop compression is accepted, not called truncated", () => {
  const original = slopPaddedOriginal();
  const compressed = original
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const result = sanitizeResponse(compressed, original, "src/items.ts", "stop");
  assert.equal(result.wasInvalid, false, "legitimate compression must not be rejected");
  assert.equal(result.content, compressed);
});

test("sanitizeResponse: truncated response keeps the ORIGINAL, never the cutoff", () => {
  const original = bigOriginal();
  const truncated = original.split("\n").slice(0, 60).join("\n");
  const result = sanitizeResponse(truncated, original, "src-tauri/src/providers.rs", "length");
  assert.equal(result.wasInvalid, true, "truncated response must be rejected");
  assert.equal(result.content, original, "original content must be preserved verbatim");
  assert.equal(result.reason, "truncated");
});

test("sanitizeResponse: finish_reason=length alone rejects the response", () => {
  const original = bigOriginal();
  const rewritten = original.replace(/handler_/g, "process_");
  // Content looks complete, but the API says it hit the token limit → reject,
  // because the model may have silently dropped the tail.
  const result = sanitizeResponse(rewritten, original, "src/x.rs", "length");
  assert.equal(result.wasInvalid, true);
  assert.equal(result.content, original);
});

test("sanitizeResponse: a complete rewrite is accepted", () => {
  const original = bigOriginal();
  const rewritten = original.replace(/handler_/g, "process_").replace(/trimmed/g, "cleaned");
  const result = sanitizeResponse(rewritten, original, "src/x.rs", "stop");
  assert.equal(result.wasInvalid, false);
  assert.equal(result.content, rewritten);
});

test("sanitizeResponse: chatbot prose is still rejected (existing behaviour)", () => {
  const original = bigOriginal();
  const prose = "Sure, here is the rewritten file:\n\n1. **Remove the imports**\n- **Fix the naming**";
  const result = sanitizeResponse(prose, original, "src/x.rs", "stop");
  assert.equal(result.wasInvalid, true);
  assert.equal(result.content, original);
});

test("looksTruncated: assembled chunk output uses stop semantics (compression allowed)", () => {
  const original = slopPaddedOriginal();
  const compressed = original
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // validateAssembledFile treats assembly as finish_reason=stop — must not reject ~50% shrink.
  assert.equal(looksTruncated(compressed, original, "stop"), false);
  assert.equal(looksTruncated(compressed, original), true);
});

test("sanitizeResponse: small file rewrite is not falsely flagged as truncated", () => {
  const original = "export const a = 1;\nexport const b = 2;\n";
  const rewritten = "export const a = 1;\nexport const b = 3;\n";
  const result = sanitizeResponse(rewritten, original, "src/tiny.ts", "stop");
  assert.equal(result.wasInvalid, false);
  assert.equal(result.content, rewritten);
});

// ---------------------------------------------------------------------------
// Hallucinated path header — the model sometimes prefixes the returned body
// with the file path it was handed (`src/git.ts`) as a bare first line. That
// stray line is never valid code and once landed above the imports, breaking
// the build. These tests pin the exact-match strip: only the path itself is
// removed, real code is never touched.
// ---------------------------------------------------------------------------

test("sanitizeResponse: strips a hallucinated path header line", () => {
  const original = "export const a = 1;\nexport const b = 2;\n";
  const raw = "src/git.ts\nexport const a = 1;\nexport const b = 3;\n";
  const result = sanitizeResponse(raw, original, "src/git.ts", "stop");
  assert.equal(result.wasInvalid, false);
  assert.equal(result.content, "export const a = 1;\nexport const b = 3;\n");
  assert.ok(!result.content.startsWith("src/git.ts"));
});

test("sanitizeResponse: strips a `File:`-prefixed path header", () => {
  const original = "export const a = 1;\nexport const b = 2;\n";
  const raw = "File: src/git.ts\n\nexport const a = 1;\nexport const b = 3;\n";
  const result = sanitizeResponse(raw, original, "src/git.ts", "stop");
  assert.equal(result.wasInvalid, false);
  assert.ok(!/^File:/.test(result.content));
  assert.ok(result.content.startsWith("export const a"));
});

test("sanitizeResponse: does NOT strip a legitimate first line", () => {
  // A normal first line that merely resembles a path must survive.
  const original = "// module: foo\n\nexport const a = 1;\n";
  const raw = "// module: foo\n\nexport const a = 1;\n";
  const result = sanitizeResponse(raw, original, "src/foo.ts", "stop");
  assert.equal(result.wasInvalid, false);
  assert.ok(result.content.startsWith("// module: foo"));
});

// ---------------------------------------------------------------------------
// End-to-end: the indentation guard wired into rewriteFile must reject a
// flattened rewrite and keep the original.
// ---------------------------------------------------------------------------

const INDENTED_ORIGINAL = [
  "export function run() {",
  "  const a = 1;",
  "  if (a) {",
  "    console.log(a);",
  "  }",
  "  return a;",
  "}",
].join("\n");

test("rewriteFile: rejects a flattened rewrite and keeps the original", async () => {
  const flattened = [
    "export function run() {",
    "const a = 1;",
    "if (a) {",
    "console.log(a);",
    "}",
    "return a;",
    "}",
  ].join("\n");
  const res = await rewriteFile("src/x.ts", INDENTED_ORIGINAL, configStub, {
    client: mockClient([flattened]),
    scope: "file",
  });
  assert.equal(res.changed, false, "flattened rewrite must not be accepted");
  assert.equal(res.rewritten, INDENTED_ORIGINAL);
  assert.equal(res.sanitizerWarning, true);
  assert.equal(res.invalidReason, "indent");
});

test("rewriteFile: accepts a well-indented rewrite", async () => {
  const wellIndented = [
    "export function run() {",
    "  const value = 1;",
    "  if (value) {",
    "    console.log(value);",
    "  }",
    "  return value;",
    "}",
  ].join("\n");
  const res = await rewriteFile("src/x.ts", INDENTED_ORIGINAL, configStub, {
    client: mockClient([wellIndented]),
    scope: "file",
  });
  assert.equal(res.changed, true);
  assert.equal(res.rewritten, wellIndented);
});

// ---------------------------------------------------------------------------
// Fragment line-count contract (the diff-mode seam corruption).
//
// Incident: in `diff` scope (used by MinionJobker et al.) the hook sliced a hunk
// plus context, asked the model to humanize it, and spliced the response back
// into a FIXED line range. When the model returned a fragment with one line
// more or fewer — merging an `if`, dropping a narration comment — the splice
// shifted every subsequent line, duplicating or deleting a line at the seam.
// The assembled file then failed to compile (or, worse, parsed but was subtly
// wrong), which the user saw as "the hook keeps truncating and makes my changes
// invalid". These tests pin the contract: a fragment MUST preserve its line
// count, and a length-changing one is rejected with the original kept.
// ---------------------------------------------------------------------------

test("fragmentLengthChanged: same line count is preserved (trailing newline tolerated)", () => {
  const original = "a\nb\nc";
  assert.equal(fragmentLengthChanged("a\nb\nc", original), false);
  assert.equal(fragmentLengthChanged("a\nb\nc\n", original), false);
  assert.equal(fragmentLengthChanged("x\ny\nz", original), false);
});

test("fragmentLengthChanged: a dropped or added line is caught", () => {
  const original = "a\nb\nc";
  assert.equal(fragmentLengthChanged("a\nc", original), true);
  assert.equal(fragmentLengthChanged("a\nb\nc\nd", original), true);
});

test("rewriteFile (diff): a line-count-changing fragment keeps the original", async () => {
  // A 20-line file; the diff touches the middle. The model returns a fragment
  // with one line FEWER (it merged two lines), which would shift the seam.
  const original = [
    "export function a() {",
    "  return 1;",
    "}",
    "export function b() {",
    "  const x = 2;",
    "  const y = 3;",
    "  return x + y;",
    "}",
    "export function c() {",
    "  return 4;",
    "}",
    "export function d() {",
    "  return 5;",
    "}",
    "export function e() {",
    "  return 6;",
    "}",
    "export function f() {",
    "  return 7;",
    "}",
  ].join("\n");
  // Model response: same slice but with one line removed.
  const shortFragment = [
    "export function b() {",
    "  const x = 2;",
    "  if (x) {",
    "    return x;",
    "  }",
    "  return 8;",
    "}",
    "export function c() {",
    "  return 4;",
    "}",
    "export function d() {",
    "  return 5;",
    "}",
    "export function e() {",
    "  return 6;",
    "}",
    "export function f() {",
    "  return 7;",
    "}",
  ].join("\n");
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -4,4 +4,3 @@",
    " export function b() {",
    "-  return x + y;",
    "+  return 8;",
    " }",
  ].join("\n");
  const res = await rewriteFile("src/x.ts", original, configStub, {
    client: mockClient([shortFragment]),
    scope: "diff",
    diff,
  });
  // The length-changing fragment must not be spliced; the file is unchanged.
  assert.equal(res.rewritten, original, "original must be kept verbatim");
  assert.equal(res.changed, false);
});

test("lineCollapseOnly: a fragment shrinking within the window is not flagged", () => {
  // A 40-line window the model tightened to 30 lines is legitimate (the
  // line-count contract handles correctness); the fragment floor must not
  // reject it as 'truncated'.
  const original = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const tightened = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(lineCollapseOnly(tightened, original, "stop"), false);
  assert.equal(lineCollapseOnly(tightened, original), false);
});

test("lineCollapseOnly: a fragment collapsing to a small fraction is still flagged", () => {
  const original = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const tiny = "line 0\nline 1\nline 2\nline 3\nline 4";
  assert.equal(lineCollapseOnly(tiny, original, "stop"), true);
});
