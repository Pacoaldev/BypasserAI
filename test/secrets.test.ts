import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractInlineApiKey,
  isConfigGitignored,
  inspectConfigSecrets,
  redactKey,
} from "../src/secrets.js";

test("secrets: extracts a non-empty inline apiKey", () => {
  assert.equal(extractInlineApiKey('{"apiKey":"sk-abc123"}'), "sk-abc123");
});

test("secrets: empty or whitespace apiKey is treated as absent", () => {
  assert.equal(extractInlineApiKey('{"apiKey":""}'), null);
  assert.equal(extractInlineApiKey('{"apiKey":"   "}'), null);
});

test("secrets: no apiKey field is absent", () => {
  assert.equal(extractInlineApiKey('{"model":"gpt-4o-mini"}'), null);
});

test("secrets: unparseable config does not throw and reports absent", () => {
  assert.equal(extractInlineApiKey("{ not json"), null);
});

test("secrets: gitignore detects an exact .bypasser.json entry", () => {
  assert.equal(isConfigGitignored("node_modules\n.bypasser.json\n"), true);
});

test("secrets: gitignore detects the .bypasser.* glob", () => {
  assert.equal(isConfigGitignored(".bypasser.*"), true);
});

test("secrets: gitignore ignores commented-out entries", () => {
  assert.equal(isConfigGitignored("# .bypasser.json\nnode_modules\n"), false);
});

test("secrets: a blanket *.json rule does NOT count as protection", () => {
  // *.json would ignore every json file — not a deliberate protection of the
  // config, so the finding must still flag it.
  assert.equal(isConfigGitignored("*.json\n"), false);
});

test("secrets: inline key + not ignored is flagged at risk", () => {
  const f = inspectConfigSecrets('{"apiKey":"sk-x"}', "node_modules\n");
  assert.equal(f.hasInlineApiKey, true);
  assert.equal(f.configGitignored, false);
  assert.equal(f.atRisk, true);
});

test("secrets: inline key + git-ignored config is not at risk", () => {
  const f = inspectConfigSecrets('{"apiKey":"sk-x"}', ".bypasser.json\n");
  assert.equal(f.atRisk, false);
});

test("secrets: no inline key is never at risk", () => {
  const f = inspectConfigSecrets('{"model":"m"}', "");
  assert.equal(f.atRisk, false);
});

test("secrets: missing config file is not at risk", () => {
  const f = inspectConfigSecrets(null, null);
  assert.equal(f.hasInlineApiKey, false);
  assert.equal(f.atRisk, false);
});

test("secrets: redactKey never reveals the full key", () => {
  const key = "sk-1234567890abcdef";
  const red = redactKey(key);
  assert.ok(!red.includes("234567890"));
  assert.ok(red.startsWith("sk-1"));
  assert.equal(redactKey("short"), "****");
});
