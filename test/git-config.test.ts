import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchGlob, shouldIgnore, getWorkingTreeFiles } from "../src/git.js";
import { resolveThreshold, type BypasserConfig } from "../src/config.js";

test("matchGlob: * matches within a path segment", () => {
  assert.equal(matchGlob("src/index.ts", "*.ts"), true);
  assert.equal(matchGlob("src/nested/index.ts", "*.ts"), true);
  assert.equal(matchGlob("src/index.js", "*.ts"), false);
});

test("matchGlob: ** matches across segments", () => {
  assert.equal(matchGlob("dist/a/b/c.js", "dist/**"), true);
  assert.equal(matchGlob("build/x.js", "dist/**"), false);
});

test("matchGlob: exact filename", () => {
  assert.equal(matchGlob("package-lock.json", "package-lock.json"), true);
  assert.equal(matchGlob("deep/pkg/package-lock.json", "package-lock.json"), true);
});

test("shouldIgnore: respects custom patterns on top of built-ins", () => {
  assert.equal(shouldIgnore("src/gen/schema.ts", ["src/gen/**"]), true);
  assert.equal(shouldIgnore("src/index.ts", ["src/gen/**"]), false);
});

function baseConfig(overrides: Partial<BypasserConfig> = {}): BypasserConfig {
  return {
    baseURL: "x",
    apiKey: "x",
    model: "x",
    threshold: 0.65,
    maxTokens: 1,
    temperature: 0.4,
    ignore: [],
    thresholds: [],
    ...overrides,
  };
}

test("resolveThreshold: falls back to global threshold", () => {
  const cfg = baseConfig();
  assert.equal(resolveThreshold("src/a.ts", cfg, matchGlob), 0.65);
});

test("resolveThreshold: first matching per-glob rule wins", () => {
  const cfg = baseConfig({
    thresholds: [
      { pattern: "src/legacy/**", value: 0.3 },
      { pattern: "*.ts", value: 0.5 },
    ],
  });
  assert.equal(resolveThreshold("src/legacy/a.ts", cfg, matchGlob), 0.3);
  assert.equal(resolveThreshold("src/a.ts", cfg, matchGlob), 0.5);
  assert.equal(resolveThreshold("src/a.py", cfg, matchGlob), 0.65);
});

test("getWorkingTreeFiles: sees unstaged + untracked files without staging", () => {
  const dir = mkdtempSync(join(tmpdir(), "bypasser-wt-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);

    // committed baseline
    writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
    git(["add", "tracked.ts"]);
    git(["commit", "-qm", "init"]);

    // modify tracked (unstaged) and add a brand-new untracked file
    writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "fresh.ts"), "export const b = 3;\n");

    const files = getWorkingTreeFiles(dir, baseConfig());
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["fresh.ts", "tracked.ts"]);

    // untracked file gets a synthesised diff whose content matches the file
    const fresh = files.find((f) => f.path === "fresh.ts")!;
    assert.match(fresh.diff, /^\+\+\+ b\/fresh\.ts/m);
    assert.match(fresh.content, /export const b = 3;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getStagedFiles: staged deletion does not leak git's 'fatal:' to stderr", () => {
  // Regression: getStagedFiles probes `git show :path` for every staged path.
  // On a staged deletion that fails, and if the child's stderr is inherited the
  // raw `fatal: path '...' does not exist` is printed into the user's commit
  // output. Run it in a child process so we can observe stderr directly.
  const dir = mkdtempSync(join(tmpdir(), "bypasser-del-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "doomed.ts"), "export const x = 1;\n");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);

    git(["rm", "-q", "doomed.ts"]);
    writeFileSync(join(dir, "fresh.ts"), "export const z = 3;\n");
    git(["add", "fresh.ts"]);

    const moduleUrl = new URL("../src/git.ts", import.meta.url).href;
    const cfg = JSON.stringify(baseConfig());
    const script =
      `import { getStagedFiles } from ${JSON.stringify(moduleUrl)};` +
      `process.stdout.write(JSON.stringify(getStagedFiles(${JSON.stringify(dir)}, ${cfg}).map(f => f.path)));`;
    const res = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /fatal:/, "git fatal must not leak to stderr");
    assert.deepEqual(JSON.parse(res.stdout), ["fresh.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
