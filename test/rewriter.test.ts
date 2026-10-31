import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeResponse,
  looksTruncated,
  truncationReason,
  rewriteFile,
  lineCollapseOnly,
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
// Fragment splicing: no line-count contract.
//
// Ranges are processed from the bottom of the file upward, so a length-changing
// fragment only shifts the content below it — content that is already
// finalized and will never be read again. All pending ranges above keep their
// original line numbers. That's why no line-count guard is needed: the
// humanizer is expected to drop narration comments / terse docblocks, which
// changes the line count legitimately every single time.
//
// The real safety nets (`looksTruncated`, `balanceRegressed`, `looksIndentBroken`,
// `looksStructurallyBroken`, `looksStubbed`, `checkSyntax`) run later on the
// assembled file and catch the actual corruption.
// ---------------------------------------------------------------------------

test("rewriteFile (diff): a line-count-changing fragment IS spliced", async () => {
  // A 20-line file; the diff touches the middle. The model returns a fragment
  // with one line FEWER (it merged two lines). With bottom-up splicing, the
  // seam shift is safe and the fragment lands in place.
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
  // Model response: same slice but tighter (it dropped the `const y = 3`
  // declaration and folded `x + y` into a literal `8`). Line count drops by
  // 2; the splice is safe because the splice range sits at the bottom of the
  // pending list, so content below never shifts anything above it.
  const shortFragment = [
    "export function a() {",
    "  return 1;",
    "}",
    "export function b() {",
    "  const x = 2;",
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
  // The humanized fragment is spliced into the file at the designated range.
  assert.equal(res.changed, true, "length-changing fragment must be accepted (bottom-up splice)");
  assert.ok(!res.rewritten!.includes("return x + y;"), "old slop line is gone");
  assert.ok(res.rewritten!.includes("return 8;"), "model's tightened form is in the file");
  // The file lost exactly the amount the fragment lost (19 vs 20 lines).
  assert.equal(res.rewritten!.split("\n").length, shortFragment.split("\n").length);
});

test("rewriteFile (diff): a severely-collapsed fragment is still rejected", async () => {
  // Legit tightening is accepted, but a fragment that collapses to a sliver of
  // its window is still "truncated" even on a clean stop.
  const original = Array.from({ length: 40 }, (_, i) => {
    return i % 2 === 0
      ? `export function f${i}() {`
      : `  return ${i};`;
  }).join("\n");
  // Model drops 35 of the 40 lines. That's a 12% survival rate — clearly a
  // partial/corrupted fragment even if it happens to end on a clean boundary.
  const tiny = original.split("\n").slice(0, 5).join("\n");
  const diff = "@@ -1,5 +1,1 @@\n-export function f0() {\n+  // compacted\n export function f2() {\n";
  const res = await rewriteFile("src/x.ts", original, configStub, {
    client: mockClient([tiny]),
    scope: "diff",
    diff,
  });
  // The catastrophic-collapse floor (`FRAGMENT_LINE_RATIO`, 0.25) still
  // fires — we do not accept an almost-empty fragment as a rewrite.
  assert.equal(res.rewritten, original, "collapsed fragment must not replace the slice");
  assert.equal(res.changed, false, "a rejected fragment leaves the file untouched");
  assert.equal(res.sanitizerWarning ?? false, true, "collapse floor must flag the fragment");
});

test("rewriteFile (diff): a collapsed assembly is never rescued as a partial humanization", async () => {
  // Incident: the pre-commit hook rewrote a `.tsx` component and committed a
  // corrupted file (168 -> 110 lines — opening tags, parens and braces gone).
  // The assembled-file check DID catch the collapse ("shrank below assembly
  // ratio"), but `finishChunkOrDiffRewrite` then rescued the slices through
  // `isSafePartialHumanization`, which re-checked bracket balance and syntax
  // only. On TSX/JSX neither has anything to say: the bracket scanner is
  // approximate and the syntax guard has no cheap parser for the language. A
  // line collapse is the one signal that *is* language-agnostic, and it must
  // never be rescued: the slices lost whole blocks, so the original wins.
  const original = Array.from({ length: 42 }, (_, i) =>
    i % 3 === 0 ? `export function f${i}() {` : i % 3 === 1 ? `  return ${i};` : `}`
  ).join("\n");
  // The model returns whole declarations, but drops most of the window: the
  // fragment survives the 0.25 floor (>0.25 of its window) and staying
  // bracket-balanced keeps `balanceRegressed` quiet, exactly like the incident.
  // `structuralCheck` is off here on purpose: the real response kept every
  // declaration and lost *content* (token and line mangling), which is the case
  // the declaration counter cannot see.
  const collapsed = [
    "export function f0() {",
    "  return 0;",
    "}",
    "export function f21() {",
    "  return 21;",
    "}",
    "export function f24() {",
    "  return 24;",
    "}",
    "export function f27() {",
    "  return 27;",
    "}",
  ].join("\n");
  // One hunk whose window (range ± contextLines) covers the whole 42-line file.
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -21,3 +21,3 @@",
    " export function f21() {",
    "-  return 21;",
    "+  return 2100;",
    " }",
  ].join("\n");
  const res = await rewriteFile("src/x.ts", original, { ...configStub, structuralCheck: false }, {
    client: mockClient([collapsed]),
    scope: "diff",
    diff,
  });
  assert.equal(
    res.rewritten,
    original,
    "an assembly that collapsed below the ratio must not be rescued as partial slices"
  );
  assert.equal(res.rewritten.split("\n").length, 42, "no lost lines reach the commit");
  assert.equal(res.changed, false, "a collapsed assembly leaves the file untouched");
});

test("rewriteFile (diff): hunks closer than contextLines cost one call, not two", async () => {
  // Two hunks 12 lines apart in a 60-line file. With a fixed small merge gap they
  // stay separate, their context windows overlap, and the second call re-sends
  // the first call's already-rewritten text as context before overwriting it.
  // Merging on `contextLines` (configStub uses 20) collapses them to one range.
  const original = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const diff = [
    "@@ -1,4 +1,4 @@",
    "-line 1",
    "+line ONE",
    " line 2",
    " line 3",
    "@@ -10,4 +10,4 @@",
    "-line 10",
    "+line TEN",
    " line 11",
    " line 12",
  ].join("\n");

  let calls = 0;
  const counting = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return {
            choices: [
              { message: { content: original }, finish_reason: "stop" },
            ],
          };
        },
      },
    },
  } as unknown as RewriteClient;

  await rewriteFile("src/x.ts", original, configStub, {
    client: counting,
    scope: "diff",
    diff,
  });
  assert.equal(calls, 1, "overlapping hunk windows must merge into a single call");
});

test("lineCollapseOnly: a fragment shrinking within the window is not flagged", () => {
  // A 40-line window the model tightened to 30 lines does not hit the fragment
  // floor (0.25). Correctness of the splice is handled by bottom-up order,
  // not by a line-count check.
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

// ---------------------------------------------------------------------------
// Regression suite for the docstring / lint-pragma damage incident.
//
// Observed in a project linted with pylint: the hook turned
// `"""Return a canned response body."""` into `# Return a canned response body.`,
// and appended a fresh `# pylint: disable=too-many-arguments` on every commit.
// Both pass every syntax guard — the file still compiles — so the damage reached
// the commit. These tests lock the two guards that keep the original instead.
// ---------------------------------------------------------------------------

const DOCSTRINGED_ORIGINAL = [
  "class FakeHttp:",
  '    """Tiny stand-in for the real HTTP client."""',
  "",
  "    def __init__(self, base_url: str) -> None:",
  "        self.base_url = base_url",
  "        self.calls: list[str] = []",
  "",
  "    def get(self, path: str) -> dict:",
  '        """Return a canned response body."""',
  "        url = self.base_url + path",
  "        self.calls.append(url)",
  '        return {"url": url, "status": 200}',
  "",
  "    def close(self) -> None:",
  '        """Release the underlying pool."""',
  "        self.calls.clear()",
].join("\n");

const DOCSTRINGS_AS_COMMENTS = [
  "class FakeHttp:",
  "    # Tiny stand-in for the real HTTP client.",
  "",
  "    def __init__(self, base_url: str) -> None:",
  "        self.base_url = base_url",
  "        self.calls: list[str] = []",
  "",
  "    def get(self, path: str) -> dict:",
  "        # Return a canned response body.",
  "        url = self.base_url + path",
  "        self.calls.append(url)",
  '        return {"url": url, "status": 200}',
  "",
  "    def close(self) -> None:",
  "        # Release the underlying pool.",
  "        self.calls.clear()",
].join("\n");

test("rewriteFile: rejects a rewrite that turns docstrings into comments", async () => {
  const res = await rewriteFile("tests/fake_http.py", DOCSTRINGED_ORIGINAL, configStub, {
    client: mockClient([DOCSTRINGS_AS_COMMENTS]),
    scope: "file",
  });
  assert.equal(res.changed, false, "a rewrite that deletes docstrings must not be accepted");
  assert.equal(res.rewritten, DOCSTRINGED_ORIGINAL);
  assert.equal(res.invalidReason, "docstring");
});

test("rewriteFile: rejects a rewrite that adds a lint-suppression pragma", async () => {
  const withPragma = "# pylint: disable=too-many-arguments\n" + DOCSTRINGED_ORIGINAL;
  const res = await rewriteFile("tests/fake_http.py", DOCSTRINGED_ORIGINAL, configStub, {
    client: mockClient([withPragma]),
    scope: "file",
  });
  assert.equal(res.changed, false, "adding a suppression pragma must not be accepted");
  assert.equal(res.rewritten, DOCSTRINGED_ORIGINAL);
  assert.equal(res.invalidReason, "pragma");
});

test("rewriteFile: accepts a rewrite that rewords docstrings in place", async () => {
  const reworded = [
    "class FakeHttp:",
    '    """Stands in for the real HTTP client."""',
    "",
    "    def __init__(self, base_url: str) -> None:",
    "        self.base_url = base_url",
    "        self.calls: list[str] = []",
    "",
    "    def get(self, path: str) -> dict:",
    '        """Return the canned body for path."""',
    "        url = self.base_url + path",
    "        self.calls.append(url)",
    '        return {"url": url, "status": 200}',
    "",
    "    def close(self) -> None:",
    '        """Drop the recorded calls."""',
    "        self.calls.clear()",
  ].join("\n");
  const res = await rewriteFile("tests/fake_http.py", DOCSTRINGED_ORIGINAL, configStub, {
    client: mockClient([reworded]),
    scope: "file",
  });
  assert.equal(res.changed, true, "rewording a docstring is legitimate tightening");
  assert.equal(res.invalidReason, undefined);
  assert.ok(res.rewritten.includes('"""Drop the recorded calls."""'));
});
