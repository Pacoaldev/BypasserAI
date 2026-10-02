import { resolveLanguage } from "./detector.js";

export interface CodeChunk {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Split source into chunks at top-level declaration boundaries, each ≤ maxLines.
 * ponytail: line-based splits on fn/class headers — not a full parser.
 */
export function splitIntoChunks(
  content: string,
  filePath: string,
  maxLines: number
): CodeChunk[] {
  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return [{ startLine: 1, endLine: lines.length, text: content }];
  }

  const p = resolveLanguage(filePath, content);
  const headerRe = new RegExp(
    p.id === "python"
      ? /^\s*(?:async\s+)?def\s+\w+|^\s*class\s+\w+/
      : p.id === "go"
        ? /^func\s+(?:\([^)]+\)\s+)?\w+/
        : p.id === "rust"
          ? /^(?:pub\s+)?(?:async\s+)?fn\s+\w+|^(?:pub\s+)?(?:struct|enum|impl)\s+/
          : /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|(?:const|let|var)\s+\w+)/
  );

  const breakLines: number[] = [1];
  for (let i = 0; i < lines.length; i++) {
    // `i + 1 > breakLines[last]` already excludes line 1 (the seed), so this
    // only pushes genuine top-level boundaries ahead of the current one.
    if (headerRe.test(lines[i]) && i + 1 > breakLines[breakLines.length - 1]) {
      breakLines.push(i + 1);
    }
  }
  if (breakLines[breakLines.length - 1] !== lines.length + 1) {
    breakLines.push(lines.length + 1);
  }

  const raw: CodeChunk[] = [];
  for (let b = 0; b < breakLines.length - 1; b++) {
    const start = breakLines[b];
    const end = breakLines[b + 1] - 1;
    raw.push({
      startLine: start,
      endLine: end,
      text: lines.slice(start - 1, end).join("\n"),
    });
  }

  const merged: CodeChunk[] = [];
  for (const chunk of raw) {
    const chunkLines = chunk.endLine - chunk.startLine + 1;
    if (chunkLines <= maxLines) {
      merged.push(chunk);
      continue;
    }
    // Hard split oversized sections
    let s = chunk.startLine;
    while (s <= chunk.endLine) {
      const e = Math.min(chunk.endLine, s + maxLines - 1);
      merged.push({
        startLine: s,
        endLine: e,
        text: lines.slice(s - 1, e).join("\n"),
      });
      s = e + 1;
    }
  }

  return merged.length > 0
    ? merged
    : [{ startLine: 1, endLine: lines.length, text: content }];
}
