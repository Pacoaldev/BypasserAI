import { resolveLanguage } from "./detector.js";
import { maskSource } from "./mask.js";

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

// ---------------------------------------------------------------------------
// Semantic-damage guards: docstrings turned into comments, and duplicated lint
// pragmas. Neither is visible to a parser, so nothing above catches them.
// ---------------------------------------------------------------------------

/** A `def` / `class` header whose suite may open with a docstring. */
const PY_SUITE_HEADER = /^(?:async[ \t]+)?(?:def|class)[ \t]+\w+.*:[ \t]*$/;
/** Opening triple quote of a docstring, with optional string prefix. */
const TRIPLE_QUOTE_OPENER = /^[rRbBuUfF]{0,2}("""|''')/;

/**
 * True when the resolved profile spells its docblock as a triple-quoted string
 * literal (Python), which is what makes a docstring *executable content* rather
 * than a comment. Read from the profile instead of hardcoding a language.
 */
function usesTripleQuotedDocstrings(code: string, filePath: string): boolean {
  return /"""|'''/.test(resolveLanguage(filePath, code).docBlock.source);
}

/**
 * Count docstrings in docstring position: the first statement of the module,
 * or of a `class` / `def` suite. A triple-quoted string anywhere else is an
 * ordinary string literal and must not be counted — dropping one of those is a
 * legitimate tightening, not damage.
 */
/** An opening `@decorator` — may sit between a suite header and its docstring. */
const PY_DECORATOR = /^@/;

function countDocstrings(code: string): number {
  const lines = code.split("\n");
  let count = 0;
  let expectDocstring = true;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    // A suite header always opens a new docstring position, so it must be
    // checked *before* consuming the pending one — otherwise a file opening on
    // `def f():` + docstring reports zero docstrings and its deletion is missed.
    if (PY_SUITE_HEADER.test(line)) {
      expectDocstring = true;
      continue;
    }
    if (!expectDocstring) continue;
    // A decorator keeps the pending position open for the suite below it.
    if (PY_DECORATOR.test(line)) continue;
    const opener = TRIPLE_QUOTE_OPENER.exec(line);
    if (opener) {
      count += 1;
      // Multi-line docstring: skip to its closing quote.
      if (!line.slice(opener[0].length).includes(opener[1])) {
        for (i += 1; i < lines.length && !lines[i].includes(opener[1]); i += 1);
      }
    }
    expectDocstring = false;
  }
  return count;
}

/**
 * True when `after` has fewer docstrings than `before`.
 *
 * A humanizer told to "comment sparingly" reads `def f():` + `"""What it
 * does."""` as the same thing as a JSDoc block and returns `# What it does.`.
 * In Python that is not cosmetic: the docstring *is* the function's `__doc__`,
 * so `help()`, pydoc, Sphinx and FastAPI's generated OpenAPI schema all lose it
 * while the file keeps parsing and every other guard stays green.
 *
 * Only the count matters, and a rewrite may freely reword a docstring — so this
 * rejects deletion, never editing. Files with no docstring to lose, and
 * languages whose docblock is already a comment (JSDoc, GoDoc, Rust `///`),
 * are untouched: dropping those is the humanizer's actual job.
 */
export function looksDocstringsStripped(
  before: string,
  after: string,
  filePath: string
): boolean {
  if (!usesTripleQuotedDocstrings(before, filePath)) return false;
  const beforeCount = countDocstrings(before);
  if (beforeCount === 0) return false;
  return countDocstrings(after) < beforeCount;
}

/**
 * A suppression pragma at the **start** of a comment's text: `pylint: disable`,
 * `pylint: skip-file`, `ruff: noqa`, `noqa`, `flake8=`, `eslint-disable`,
 * `@ts-ignore`, `type: ignore`, `fmt: off`.
 *
 * Anchored, because a comment that merely *mentions* one is prose
 * (`# the flake8=: operator confuses people`) and must not count.
 */
const LINT_PRAGMA =
  /^(?:pylint:[ \t]*(?:disable|skip-file)|ruff:[ \t]*(?:noqa|ignore)|noqa\b|flake8[:=]|eslint-disable|@ts-(?:ignore|expect-error|nocheck)|type:[ \t]*ignore|(?:fmt|format):[ \t]*(?:off|skip))/i;

/**
 * Count suppression pragmas in `code`, read from the masked **comments** view
 * so a string literal or docstring that quotes a pragma (`msg = "use # noqa"`)
 * never counts, and a comment marker inside a string never looks like one.
 * Reuses `maskSource` instead of a second, weaker scanner.
 */
function countLintPragmas(code: string, filePath: string): number {
  const { comments } = maskSource(code, resolveLanguage(filePath, code));
  let count = 0;
  for (const line of comments.split("\n")) {
    if (LINT_PRAGMA.test(line.trim())) count += 1;
  }
  return count;
}

/**
 * True when `after` carries more suppression pragmas than `before`.
 *
 * In a project that lints with pylint the model treats every warning it did not
 * fix as something to silence, appending `# pylint: disable=…` instead of
 * fixing the cause — and re-appending another copy on each commit, which is the
 * duplicated-disables churn seen there. Suppressing a linter to look more human
 * degrades the file; `docs/SKILL.*.md` forbids it too, and this makes it
 * enforceable.
 */
export function looksLintPragmaAdded(
  before: string,
  after: string,
  filePath: string
): boolean {
  return countLintPragmas(after, filePath) > countLintPragmas(before, filePath);
}
