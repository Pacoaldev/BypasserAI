import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { install, uninstall, isHookInstallExcluded, HOOK_INSTALL_EXCLUDED_REPO_NAMES } from "../src/installer.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bypasser-hook-"));
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  // Make it a real git repo so `git rev-parse --git-path` works in callers, even
  // though install() does not require it.
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  return dir;
}

test("install writes an extensionless pre-commit sh hook (git ignores .cmd)", () => {
  const repo = makeRepo();
  try {
    install(repo);
    const hook = join(repo, ".git", "hooks", "pre-commit");

    assert.ok(existsSync(hook), "extensionless pre-commit must be created");
    // Git for Windows ignores pre-commit.cmd/.bat entirely, so we must never
    // rely on one for the hook itself.
    assert.equal(
      existsSync(join(repo, ".git", "hooks", "pre-commit.cmd")),
      false,
      "pre-commit.cmd must NOT be the hook — git ignores it"
    );

    const text = readFileSync(hook, "utf8");
    assert.match(text, /^#!\/bin\/sh/m, "hook must start with a #!/bin/sh shebang");
    assert.ok(text.includes("# bypasser-ai"), "hook must carry the ownership marker");
    assert.match(text, /bypasser audit --pre-commit|node "\$cli" audit --pre-commit/);
    assert.doesNotMatch(text, /--verbose/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("install on Windows also writes the hidden VBS toast runner", () => {
  const repo = makeRepo();
  try {
    install(repo);
    const vbs = join(repo, ".git", "hooks", "pre-commit-runner.vbs");
    if (process.platform === "win32") {
      assert.ok(existsSync(vbs), "pre-commit-runner.vbs must be created on Windows");
      const text = readFileSync(vbs, "utf8");
      assert.match(text, /WScript\.Shell/i, "runner must use WScript.Shell");
      assert.match(text, /shell\.Run/i);
      // WindowStyle=0 means hidden — the whole point.
      assert.match(text, /,\s*0\s*,\s*False/);
      assert.match(text, /bypasser-ai-toast\.ps1/, "runner must look for the queued toast script");
    } else {
      assert.equal(existsSync(vbs), false, "no VBS runner off Windows");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("install is idempotent", () => {
  const repo = makeRepo();
  try {
    install(repo);
    install(repo); // second call must not throw or overwrite
    const hook = readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf8");
    assert.ok(hook.includes("# bypasser-ai"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repos listed in BYPASSER_HOOK_EXCLUDED_REPOS are refused for hook install", () => {
  const parent = mkdtempSync(join(tmpdir(), "bypasser-excl-"));
  const excludedName = "some-own-hook-repo";
  const repo = join(parent, excludedName);
  // The exclusion list is read from the env var at module load; add our test
  // name directly so the assertion is independent of machine config.
  HOOK_INSTALL_EXCLUDED_REPO_NAMES.add(excludedName);
  try {
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    execSync("git init -q", { cwd: repo });
    assert.equal(isHookInstallExcluded(repo), true);
    assert.throws(() => install(repo), /disabled.*some-own-hook-repo/i);
    assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false);
  } finally {
    HOOK_INSTALL_EXCLUDED_REPO_NAMES.delete(excludedName);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("install refuses to overwrite an existing non-bypasser hook", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "user-owned hook", "utf8");
    assert.throws(() => install(repo), /already exists/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("install sweeps a stale pre-commit.cmd trampoline from an older version", () => {
  const repo = makeRepo();
  try {
    const legacy = join(repo, ".git", "hooks", "pre-commit.cmd");
    writeFileSync(legacy, "# bypasser-ai\n@echo off\n", "utf8");
    install(repo);
    assert.equal(existsSync(legacy), false, "stale .cmd trampoline must be removed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("uninstall removes the hook and the VBS runner", () => {
  const repo = makeRepo();
  try {
    install(repo);
    uninstall(repo);
    assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false);
    assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit-runner.vbs")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
