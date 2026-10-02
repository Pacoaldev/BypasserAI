export interface HunkRange {
  /** 1-based inclusive start line in the new (staged) file */
  newStart: number;
  /** 1-based inclusive end line in the new file */
  newEnd: number;
}

/** Parse unified diff hunks into new-file line ranges (1-based). */
export function parseHunkRanges(diff: string): HunkRange[] {
  const ranges: HunkRange[] = [];
  const lines = diff.split("\n");
  let newLine = 0;
  let hunkStart = 0;
  let hunkEnd = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (inHunk && hunkEnd >= hunkStart) {
        ranges.push({ newStart: hunkStart, newEnd: hunkEnd });
      }
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) {
        inHunk = false;
        continue;
      }
      newLine = parseInt(m[1], 10);
      hunkStart = newLine;
      hunkEnd = newLine;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      hunkEnd = newLine;
      newLine++;
    } else if (line.startsWith("-")) {
      // removed from old only
    } else if (line.startsWith(" ") || line === "") {
      newLine++;
    }
  }
  if (inHunk && hunkEnd >= hunkStart) {
    ranges.push({ newStart: hunkStart, newEnd: hunkEnd });
  }
  return ranges;
}

/** Merge hunks whose gaps are smaller than `gapLines`. */
export function mergeHunkRanges(ranges: HunkRange[], gapLines: number): HunkRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.newStart - b.newStart);
  const out: HunkRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.newStart - prev.newEnd <= gapLines) {
      prev.newEnd = Math.max(prev.newEnd, cur.newEnd);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

export function sliceWithContext(
  content: string,
  range: HunkRange,
  contextLines: number
): { slice: string; startLine: number; endLine: number } {
  const lines = content.split("\n");
  const startLine = Math.max(1, range.newStart - contextLines);
  const endLine = Math.min(lines.length, range.newEnd + contextLines);
  const slice = lines.slice(startLine - 1, endLine).join("\n");
  return { slice, startLine, endLine };
}

export function spliceSlice(
  content: string,
  startLine: number,
  endLine: number,
  newSlice: string
): string {
  const lines = content.split("\n");
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const middle = newSlice.split("\n");
  return [...before, ...middle, ...after].join("\n");
}

/** Fraction of file lines that appear as added in a unified diff. */
export function addedLineFraction(diff: string, totalLines: number): number {
  if (totalLines <= 0) return 1;
  let added = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
  }
  return added / totalLines;
}
