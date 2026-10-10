/**
 * Balance false-positive scanner.
 *
 * `hasUnbalancedBrackets` is a regex-grade heuristic, not a parser. It is used
 * as a truncation tell on rewrites, so a *false* "unbalanced" on valid code is
 * costly: the rewrite is rejected, the API call is wasted, and the original
 * slop is committed. This script measures how often the scanner flags real
 * files in a repo, to catch regressions in TSX/JSX, regex literals, template
 * interpolations, etc.
 *
 * A valid source file reported here is a false positive (a file that cannot be
 * parsed is *not* what we want to flag here — this scanner only checks balance,
 * and balance != parseable for constructs it does not model).
 *
 * Run: npx tsx scripts/scan-balance.ts <repoDir>
 */
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { resolveLanguage } from "../src/detector.js";
import { hasUnbalancedBrackets } from "../src/bracket-balance.js";

const repo = process.argv[2] ?? process.cwd();

const files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

let unbalanced = 0;
let total = 0;
const offenders: string[] = [];

for (const f of files) {
  let code: string;
  try {
    code = readFileSync(join(repo, f), "utf8");
  } catch {
    continue;
  }
  total++;
  const profile = resolveLanguage(f, code);
  if (hasUnbalancedBrackets(code, profile)) {
    unbalanced++;
    if (offenders.length < 25) offenders.push(f);
  }
}

console.log(`Repo: ${repo}`);
console.log(`TS/JS files scanned: ${total}`);
console.log(
  `Reported UNBALANCED (false positives if valid code): ${unbalanced} (${((unbalanced / total) * 100).toFixed(1)}%)`
);
if (offenders.length > 0) {
  console.log(`\nFirst offenders:`);
  for (const o of offenders) console.log(`  ${o}`);
}
