import {
  existsSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "fs";
import { resolve } from "path";

const HOOK_MARKER = "# bypasser-ai";

const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}
bypasser audit --pre-commit --verbose
exit $?
`;

export function install(cwd = process.cwd()): void {
  const hookDir = resolve(cwd, ".git", "hooks");
  if (!existsSync(hookDir)) {
    throw new Error(
      "No .git/hooks directory found. Is this a git repository?"
    );
  }

  const hookPath = resolve(hookDir, "pre-commit");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (existing.includes(HOOK_MARKER)) {
      console.log("bypasser-ai pre-commit hook already installed.");
      return;
    }
    // append to existing hook
    writeFileSync(hookPath, existing.trimEnd() + "\n\n" + HOOK_SCRIPT, "utf8");
    console.log("bypasser-ai hook appended to existing pre-commit hook.");
  } else {
    writeFileSync(hookPath, HOOK_SCRIPT, "utf8");
    console.log("bypasser-ai pre-commit hook installed.");
  }

  // make executable (no-op on Windows but harmless)
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // windows — skip
  }
}

export function uninstall(cwd = process.cwd()): void {
  const hookPath = resolve(cwd, ".git", "hooks", "pre-commit");
  if (!existsSync(hookPath)) {
    console.log("No pre-commit hook found.");
    return;
  }

  const content = readFileSync(hookPath, "utf8");
  if (!content.includes(HOOK_MARKER)) {
    console.log("bypasser-ai hook not found in pre-commit.");
    return;
  }

  // remove our block
  const cleaned = content
    .split("\n")
    .reduce<{ result: string[]; skip: boolean }>(
      (acc, line) => {
        if (line.includes(HOOK_MARKER)) return { result: acc.result, skip: true };
        if (acc.skip && line.trim() === "") return { result: acc.result, skip: false };
        if (!acc.skip) acc.result.push(line);
        return acc;
      },
      { result: [], skip: false }
    )
    .result.join("\n")
    .trimEnd();

  if (cleaned === "#!/bin/sh" || cleaned === "") {
    // nothing left — remove the file entirely? keep the shebang
    writeFileSync(hookPath, "#!/bin/sh\n", "utf8");
  } else {
    writeFileSync(hookPath, cleaned + "\n", "utf8");
  }

  console.log("bypasser-ai hook removed from pre-commit.");
}
