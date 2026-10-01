import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeResponse, looksTruncated } from "../src/rewriter.js";

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

test("sanitizeResponse: small file rewrite is not falsely flagged as truncated", () => {
  const original = "export const a = 1;\nexport const b = 2;\n";
  const rewritten = "export const a = 1;\nexport const b = 3;\n";
  const result = sanitizeResponse(rewritten, original, "src/tiny.ts", "stop");
  assert.equal(result.wasInvalid, false);
  assert.equal(result.content, rewritten);
});
