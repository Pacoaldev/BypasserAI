import { resolveLanguage } from "./detector.js";

const STRUCTURAL_DROP_RATIO = 0.15;

/**
 * Markers a model leaves when it *omits* code instead of rewriting it. They
 * are never valid source in any language, so their mere presence is a
 * 100%-precision signal that the response is a stub, not a rewrite.
 *
 * This is the failure `zd/claude-sonnet-4-5` produced on Python:
 *
 *     results = [lead for leads in _leads.values() for lead in leads]
 *     # [1 lines omitted]
 *     pass
 *
 * The body's real `return [...]` was replaced by the marker + `pass`, so the
 * function silently returned `None`. Python still parses (`pass` is valid), so
 * the syntax guard and the line-collapse guard both missed it — a semantic
 * corruption that reached the commit. These markers catch it deterministically.
 */
const OMISSION_MARKERS = [
  /\[?\s*\d+\s+lines?\s+omitted\s*\]?/i,
  /\[\s*\.\.\.\s*omitted\s*\]/i,
  /^\s*#\s*\.\.\.\s*omitted.*$/im,
  /^\s*\/\/\s*\.\.\.\s*omitted.*$/im,
  /^\s*\.\.\.\s*omitted.*$/im,
];

/**
 * True when `after` carries an explicit "code was omitted here" marker — a stub
 * masquerading as a rewrite. Independent of language: no real source file
 * contains a literal "N lines omitted" banner, so a match is always a
 * corruption, never a false positive.
 */
export function looksStubbed(after: string): boolean {
  return OMISSION_MARKERS.some((re) => re.test(after));
}

/**
 * Indent unit detection thresholds.
 *
 * A destroyer response flattens indentation (a `const x` inside a function
 * comes back at column 0). Legit rewrites may reflow a line or two, so we only
 * reject when the indentation profile is *systemically* broken, never on a
 * single-line difference.
 */
/** Fraction of non-blank lines whose indentation may regress before rejecting. */
const INDENT_REGRESSION_TOLERANCE = 0.35;
/** Half an indent unit of median slack — a real flatten drops a whole level. */
const INDENT_MEDIAN_SLACK_UNITS = 0.5;

interface IndentProfile {
  /** Median indent width (in spaces) of the non-blank lines. */
  median: number;
  /** Fraction of non-blank lines indented more than 0. */
  indentedRatio: number;
  /** Detected indent unit (2, 4, or 8), or 0 when the file has no indentation. */
  unit: number;
}

function leadingSpaces(line: string): number {
  const m = line.match(/^[ \t]*/);
  if (!m) return 0;
  // Tabs count as one indent unit (4) to keep comparisons meaningful.
  const raw = m[0];
  let width = 0;
  for (const ch of raw) width += ch === "\t" ? 4 : 1;
  return width;
}

function indentProfile(code: string): IndentProfile {
  const widths: number[] = [];
  for (const line of code.split("\n")) {
    if (line.trim() === "") continue;
    widths.push(leadingSpaces(line));
  }
  if (widths.length === 0) return { median: 0, indentedRatio: 0, unit: 0 };

  const sorted = [...widths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const indented = widths.filter((w) => w > 0).length;
  const indentedRatio = indented / widths.length;

  // Smallest positive indentation is the most likely indent unit (2 or 4).
  const positive = sorted.filter((w) => w > 0);
  let unit = 0;
  if (positive.length > 0) {
    const smallest = positive[0];
    unit = smallest >= 4 ? 4 : smallest;
  }
  return { median, indentedRatio, unit };
}

/**
 * Detect a rewrite that systemically destroys the fragment's indentation
 * structure — the failure mode where a model returns code with correct tokens
 * but flattened leading whitespace (a `const` that belongs inside a function
 * comes back at column 0). This passes every bracket/declaration guard because
 * the code still *tokenizes*, yet it is structurally wrong and ugly.
 *
 * Deliberately conservative: a rewrite is only rejected when BOTH
 *   - the indented-line ratio collapses (systemic flattening), AND
 *   - the median indent shrinks past the absolute floor,
 * hold. A single reflowed line never trips it. Files with no indentation
 * (e.g. flat JSON) are ignored entirely.
 */
export function looksIndentBroken(before: string, after: string): boolean {
  const b = indentProfile(before);
  const a = indentProfile(after);

  // Nothing to protect: the original was flat, so any profile is acceptable.
  if (b.indentedRatio < 0.25 || b.unit === 0) return false;

  // The rewrite must retain *some* indentation and not collapse the ratio.
  const ratioDropped =
    a.indentedRatio < b.indentedRatio * (1 - INDENT_REGRESSION_TOLERANCE);
  const medianDropped =
    a.median < b.median - b.unit * INDENT_MEDIAN_SLACK_UNITS;

  return ratioDropped && medianDropped;
}

function countDeclarations(code: string, filePath: string): number {
  const p = resolveLanguage(filePath, code);
  const seen = new Set<number>();
  const re = new RegExp(
    p.fnDecl.source,
    p.fnDecl.flags.includes("g") ? p.fnDecl.flags : p.fnDecl.flags + "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    seen.add(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  // Classes / modules — rough top-level shape per language
  const classRe =
    p.id === "python"
      ? /\bclass\s+\w+/g
      : p.id === "ruby"
        ? /\bclass\s+\w+/g
        : /\b(?:export\s+)?(?:abstract\s+)?class\s+\w+/g;
  let c: RegExpExecArray | null;
  while ((c = classRe.exec(code)) !== null) {
    seen.add(c.index);
    if (c.index === classRe.lastIndex) classRe.lastIndex++;
  }
  return seen.size;
}

/**
 * ponytail: regex/heuristic — catches dropped functions, not renamed refactors.
 */
export function looksStructurallyBroken(
  before: string,
  after: string,
  filePath: string
): boolean {
  const beforeCount = countDeclarations(before, filePath);
  if (beforeCount < 3) return false;
  const afterCount = countDeclarations(after, filePath);
  return afterCount < beforeCount * (1 - STRUCTURAL_DROP_RATIO);
}
