#!/usr/bin/env node
import { install, uninstall } from "./installer.js";
import { runAudit } from "./audit.js";
import { detectAI, extractAddedLines } from "./detector.js";
import { getStagedFiles } from "./git.js";
import { loadConfig } from "./config.js";
import { writeFileSync } from "fs";
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
      const staged = getStagedFiles(cwd, config);

      if (staged.length === 0) {
        console.log("No staged files to analyze.");
        break;
      }

      let anyAbove = false;
      for (const file of staged) {
        const added = extractAddedLines(file.diff);
        if (added.trim().split("\n").length < 5) {
          console.log(`${file.path}: skipped (too few changed lines)`);
          continue;
        }
        const result = detectAI(added);
        const pct = (result.score * 100).toFixed(0);
        const bar = scoreBar(result.score);
        const label = result.score >= config.threshold ? "⚠ ABOVE THRESHOLD" : "✓ ok";
        console.log(`\n${file.path}: ${pct}% AI-score ${bar} ${label}`);
        const fired = result.signals.filter((s) => s.fired);
        if (fired.length > 0 && flags.has("--verbose")) {
          fired.forEach((s) => console.log(`  ✗ [${s.family}] ${s.description}`));
        }
        if (result.score >= config.threshold) anyAbove = true;
      }

      process.exit(anyAbove ? 1 : 0);
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
      const verbose = flags.has("--verbose") || flags.has("-v");
      const preCommit = flags.has("--pre-commit");

      try {
        const result = await runAudit({ cwd, dryRun, verbose });

        if (result.totalFiles === 0) {
          // always print something so the user knows the hook ran
          if (preCommit) console.log("bypasser-ai: nothing to scan.");
          else console.log("No eligible staged files.");
          process.exit(0);
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

        process.exit(0);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`bypasser-ai error: ${msg}`);
        // never block the commit on tool errors
        process.exit(0);
      }
    }

    case "init": {
      // create a default .bypasser.json in the project
      const defaultConfig = {
        baseURL: "https://api.openai.com/v1",
        model: "gpt-4o",
        threshold: 0.65,
        maxTokens: 4096,
        ignore: [],
      };
      const configPath = resolve(cwd, ".bypasser.json");
      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n", "utf8");
      console.log(
        "Created .bypasser.json — add your API key via BYPASSER_API_KEY env var or apiKey field."
      );
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
  install               Install the pre-commit git hook
  uninstall             Remove the pre-commit git hook
  detect                Score staged files and report AI signals
  detect --verbose      Show individual signal details
  rewrite <file>        Rewrite a specific file via the API
  audit                 Detect + rewrite staged files above threshold
  audit --dry-run       Detect only, do not call the API or restage
  audit --verbose       Show per-file signal details

ENVIRONMENT VARIABLES
  BYPASSER_API_KEY      API key (overrides .bypasser.json)
  OPENAI_API_KEY        Fallback API key
  BYPASSER_BASE_URL     API base URL (default: https://api.openai.com/v1)
  BYPASSER_MODEL        Model name (default: gpt-4o)

DOCS
  https://github.com/pacoaldev/bypasser-ai
`);
}

function scoreBar(score: number): string {
  const filled = Math.round(score * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
