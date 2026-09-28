import { appendFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const LOG_FILE = ".bypasser.log";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function writeLog(cwd: string, lines: string[]): void {
  const logPath = resolve(cwd, LOG_FILE);
  const header = `\n── ${timestamp()} ─────────────────────────────────────`;
  const block = [header, ...lines, ""].join("\n");

  try {
    if (!existsSync(logPath)) {
      // create with a header so the file is readable from the start
      writeFileSync(logPath, "# bypasser-ai — commit scan log\n", "utf8");
    }
    appendFileSync(logPath, block, "utf8");
  } catch {
    // never block the commit because of a log write failure
  }
}
