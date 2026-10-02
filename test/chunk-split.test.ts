import { test } from "node:test";
import assert from "node:assert/strict";
import { splitIntoChunks } from "../src/chunk-split.js";

test("splitIntoChunks keeps small files as one chunk", () => {
  const content = "export function a() {}\nexport function b() {}\n";
  const chunks = splitIntoChunks(content, "x.ts", 450);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
});

test("splitIntoChunks splits a long file into multiple chunks", () => {
  const lines: string[] = [];
  for (let i = 0; i < 80; i++) {
    lines.push(`export function fn${i}() { return ${i}; }`);
  }
  const content = lines.join("\n");
  const chunks = splitIntoChunks(content, "big.ts", 30);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.endLine - c.startLine + 1 <= 30);
  }
});
