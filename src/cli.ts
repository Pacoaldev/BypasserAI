#!/usr/bin/env node
import { install, uninstall } from "./installer.js";
import { runAudit } from "./audit.js";
import { detectAI, countChangedLines } from "./detector.js";
import { getStagedFiles, getWorkingTreeFiles, matchGlob } from "./git.js";
import { loadConfig, resolveThreshold } from "./config.js";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.slice(1));

const cwd = process.cwd();

async function main() {
  switch (command) {
    case "install":
      install(cwd);
      break;

    case "uninstall":
      uninstall(cwd);
      break;

    case "detect": {
      const config = loadConfig(cwd);
      const all = flags.has("--all");
      const staged = all
        ? getWorkingTreeFiles(cwd, config)
        : getStagedFiles(cwd, config);

      if (staged.length === 0) {
        console.log(
          all
            ? "No changed files in the working tree."
            : "No staged files to analyze. Use --all to scan the working tree."
        );
        break;
      }

      console.log(
        `Scanning ${staged.length} ${all ? "working-tree" : "staged"} file(s)...\n`
      );

      let anyAbove = false;
      for (const file of staged) {
        const threshold = resolveThreshold(file.path, config, matchGlob);
        if (countChangedLines(file.diff) < 5) {
          console.log(`${file.path}: skipped (too few changed lines)`);
          continue;
        }
        // Score the full file content, not just the added diff lines — see
        // audit.ts for why (diff-only scoring reported 0% on 100% AI files).
        const result = detectAI(file.content, file.path);
        const pct = (result.score * 100).toFixed(0);
        const bar = scoreBar(result.score);
        const label = result.score >= threshold ? "⚠ ABOVE THRESHOLD" : "✓ ok";
        console.log(`\n${file.path}: ${pct}% AI-score ${bar} ${label}`);
        const fired = result.signals.filter((s) => s.fired);
        if (fired.length > 0 && flags.has("--verbose")) {
          fired.forEach((s) => console.log(`  ✗ [${s.family}] ${s.description}`));
        }
        if (result.score >= threshold) anyAbove = true;
      }

      return anyAbove ? 1 : 0;
    }

    case "rewrite": {
      // rewrite a specific file passed as argument
      const filePath = args[1];
      if (!filePath) {
        console.error("Usage: bypasser rewrite <file>");
        process.exit(1);
      }
      const config = loadConfig(cwd);
      if (!config.apiKey) {
        console.error(
          "No API key. Set BYPASSER_API_KEY or OPENAI_API_KEY, or add apiKey to .bypasser.json"
        );
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const content = readFileSync(resolve(cwd, filePath), "utf8");
      const { rewriteFile } = await import("./rewriter.js");
      console.log(`Rewriting ${filePath}...`);
      const res = await rewriteFile(filePath, content, config);
      if (res.changed) {
        writeFileSync(resolve(cwd, filePath), res.rewritten, "utf8");
        console.log(`✓ Rewritten: ${filePath}`);
      } else {
        console.log(`✓ No changes needed: ${filePath}`);
      }
      break;
    }

    case "audit": {
      const dryRun = flags.has("--dry-run");
      const verbose =
        flags.has("--verbose") ||
        flags.has("-v") ||
        process.env.BYPASSER_VERBOSE === "1";
      const preCommit = flags.has("--pre-commit");

      try {
        const result = await runAudit({ cwd, dryRun, verbose });

        if (result.totalFiles === 0) {
          // always print something so the user knows the hook ran
          if (preCommit) console.log("bypasser-ai: nothing to scan.");
          else console.log("No eligible staged files.");
          return 0;
        }

        // always print the per-file summary — visible in every IDE's commit output
        console.log(`\nbypasser-ai — ${result.totalFiles} file(s) scanned`);
        for (const f of result.files) {
          const pct = (f.score * 100).toFixed(0);
          const bar = scoreBar(f.score);

          let status: string;
          if (f.skippedReason) {
            status = `· skipped (${f.skippedReason})`;
          } else if (f.rewritten) {
            status = `✓ humanized & re-staged`;
          } else {
            status = `✓ ok`;
          }

          console.log(`  ${f.path}: ${pct}% ${bar} ${status}`);
        }

        if (result.rewrittenFiles > 0) {
          console.log(
            `\n  → ${result.rewrittenFiles} file(s) rewritten. Commit will use humanized version.`
          );
        }
        if (result.rejectedFiles > 0) {
          console.warn(
            `\n  ⚠ ${result.rejectedFiles} file(s) failed safety checks — originals kept.`
          );
        }
        if (result.errorFiles > 0) {
          console.error(
            `\n  ⚠ ${result.errorFiles} file(s) needed rewriting but the API call failed.`
          );
          console.error(
            `     Check the endpoint in .bypasser.json and see .bypasser.log for details.`
          );
        }

        process.exit(0);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`bypasser-ai error: ${msg}`);
        // never block commit on tool errors
        process.exit(0);
      }
      break;
    }
    case "init": {
      // create a default .bypasser.json in the project
      const configPath = resolve(cwd, ".bypasser.json");

      // Guard: never clobber an existing config (it may hold an apiKey or
      // hand-tuned ignore/thresholds). Only regenerate with --force.
      if (existsSync(configPath) && !flags.has("--force")) {
        console.log(
          ".bypasser.json already exists — leaving it untouched. Use `bypasser init --force` to regenerate it."
        );
        break;
      }

      const defaultConfig = {
        baseURL: "http://localhost:20128/v1",
        model: "zd/claude-sonnet-4-5",
        threshold: 0.65,
        maxTokens: 16384,
        temperature: 0.4,
        ignore: [],
        thresholds: [],
        rewriteConcurrency: 3,
        rewriteScope: "auto",
        rewriteFullFileBelowLines: 400,
        contextLines: 60,
        maxChunkLines: 450,
        structuralCheck: true,
      };
      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n", "utf8");
      console.log(
        "Created .bypasser.json — add your API key via BYPASSER_API_KEY env var or apiKey field."
      );
      ensureGitignoreEntries(cwd);
      console.log('Run "bypasser install" to install the pre-commit hook.');
      break;
    }

    default:
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

function printHelp() {
  console.log(`
bypasser-ai — AI code pattern detector & humanizer

COMMANDS
  init                  Create a default .bypasser.json config
  init --force          Overwrite an existing .bypasser.json
  install               Install the pre-commit git hook
  uninstall             Remove the pre-commit git hook
  detect                Score staged files and report AI signals
  detect --all          Score changed files in the working tree (no staging needed)
  detect --verbose      Show individual signal details
  rewrite <file>        Rewrite a specific file via the API
  audit                 Detect + rewrite staged files above threshold
  audit --dry-run       Detect only, do not call the API or restage
  audit --verbose       Show per-file signal details

ENVIRONMENT VARIABLES
  BYPASSER_API_KEY      API key (overrides .bypasser.json)
  OPENAI_API_KEY        Fallback API key
  BYPASSER_BASE_URL     API base URL (default: http://localhost:20128/v1)
  BYPASSER_MODEL        Model name (default: zd/claude-sonnet-4-5)

DOCS
  https://github.com/pacoaldev/bypasser-ai
`);
}

/**
 * Ensure the tool's local artifacts are git-ignored in the host project, so a
 * user does not accidentally commit `.bypasser.log` or `.bypasser.state.json`.
 * Idempotent: only appends entries that are not already present.
 */
function ensureGitignoreEntries(cwd: string): void {
  const wanted = [
    ".bypasser.log",
    ".bypasser.state.json",
    "*.bypasser.tmp",
    "*.bak",
  ];
  const gitignorePath = resolve(cwd, ".gitignore");

  let current = "";
  if (existsSync(gitignorePath)) {
    current = readFileSync(gitignorePath, "utf8");
  }

  const missing = wanted.filter(
    (entry) => !current.split("\n").some((line) => line.trim() === entry)
  );
  if (missing.length === 0) return;

  const block =
    (current.endsWith("\n") || current === "" ? "" : "\n") +
    "\n# bypasser-ai\n" +
    missing.join("\n") +
    "\n";

  try {
    if (existsSync(gitignorePath)) {
      appendFileSync(gitignorePath, block, "utf8");
    } else {
      writeFileSync(gitignorePath, block.trimStart(), "utf8");
    }
    console.log("Added .bypasser.log / .bypasser.state.json to .gitignore.");
  } catch {
    // non-fatal
  }
}

function scoreBar(score: number): string {
  const filled = Math.round(score * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
