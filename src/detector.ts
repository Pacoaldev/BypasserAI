/**
 * Heuristic detector for AI-generated code patterns.
 *
 * Scores a code snippet or diff chunk from 0 (likely human) to 1 (likely AI).
 * Does NOT call any external API — fully deterministic, usable in CI for free.
 *
 * Each signal family contributes a weighted sub-score. The final score is a
 * weighted average, clamped to [0, 1].
 */

export interface DetectorResult {
  score: number;
  signals: Signal[];
}

export interface Signal {
  family: SignalFamily;
  description: string;
  weight: number;
  fired: boolean;
}

export type SignalFamily =
  | "naming"
  | "structure"
  | "comments"
  | "error-handling"
  | "abstraction"
  | "uniformity";

// ---------------------------------------------------------------------------
// Structural helpers
//
// The original signal predicates were written against toy snippets and their
// regexes never matched idiomatic real-world code:
//   - they only recognised `const x = () =>` and missed `export async function`,
//   - they tried to match function bodies with `[^}]` (breaks on any nesting),
//   - they required ≥2 occurrences of things that appear once in real files.
// The result was that 8 of the 13 signals were DEAD — they never fired on any
// real AI-generated file. These helpers do line-based analysis instead, which
// is far more robust across languages and styles.
// ---------------------------------------------------------------------------

/** Count function-like declarations: `function f`, `export async function f`, `const f = (` / `= async (`, arrow props. */
function countFunctions(code: string): number {
  const patterns = [
    /\bfunction\s+\w+/g, // function foo, export async function foo
    /\bconst\s+\w+\s*=\s*(?:async\s*)?\(/g, // const f = (…) =>
    /\bconst\s+\w+\s*=\s*async\s+\w+/g, // const f = async function
    /\b\w+\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g, // obj.method: (…) =>
    /=>\s*[{(]/g, // any arrow body
  ];
  const seen = new Set<number>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(code)) !== null) {
      seen.add(m.index);
      if (m.index === r.lastIndex) r.lastIndex++;
    }
  }
  return seen.size;
}

/** Count arrow-function bodies specifically (`=>`, `=> {`). */
function countArrowFunctions(code: string): number {
  return (code.match(/=>\s*[{(]/g) ?? []).length;
}

/** Count traditional `function` declarations. */
function countTraditionalFunctions(code: string): number {
  return (code.match(/\bfunction\s+\w+/g) ?? []).length;
}

/** Count `catch (...) {` handlers, tolerant of whitespace and optional binding. */
function countCatchBlocks(code: string): number {
  return (code.match(/\bcatch\s*(?:\([^)]*\))?\s*\{/g) ?? []).length;
}

/** Count async functions (`async function f`, `async (…) =>`, `async f =>`). */
function countAsyncFunctions(code: string): number {
  return (
    code.match(/\basync\s+(?:function\b|\w+\s*=>|\([^)]*\)\s*=>|\w+\s*\()/g) ?? []
  ).length;
}

/** Count `try {` blocks. */
function countTryBlocks(code: string): number {
  return (code.match(/\btry\s*\{/g) ?? []).length;
}

/** Count JSDoc `/** … *\/` blocks spanning at least 3 lines. */
function countJsDocBlocks(code: string): number {
  return (code.match(/\/\*\*[\s\S]*?\*\//g) ?? []).length;
}

/** Non-blank line count. */
function codeLineCount(code: string): number {
  return code.split("\n").filter((l) => l.trim().length > 0).length;
}

/** Count lines whose only content is a line or block comment. */
function countCommentLines(code: string): number {
  const lines = code.split("\n");
  let n = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) n++;
  }
  return n;
}

/** Count `interface X {` declarations (and TS `type X = {` payload shapes). */
function countInterfaces(code: string): number {
  return (code.match(/\binterface\s+\w+/g) ?? []).length;
}

/**
 * Detect over-narration in comments: comments that restate what the very next
 * line of code plainly does. Rather than a fixed phrase list (which real AI
 * never matches verbatim), we look for the *pattern*: an imperative/narrative
 * English comment starting a sentence, which is the hallmark of AI narration.
 */
function hasNarratingComments(code: string): boolean {
  const lines = code.split("\n");
  const NARRATION =
    /^\s*(\/\/|\*)\s+(?:This|The|These|Here|Now|Then|First|Next|Finally|It|We|You|Returns?|Gets?|Sets?|Handles?|Checks?|Validates?|Initializes?|Creates?|Iterates?|Loops?|Builds?|Parses?|Reads?|Writes?|Loads?|Saves?|Fetches?|Computes?|Calculates?|Converts?|Transforms?|Processes?|Adds?|Removes?|Updates?|Skips?|Scores?|Writes?|Fires?|Wraps?|Ensures?|Marks?|Records?|Applies?|Installs?|Removes?)\b/;
  let narrated = 0;
  for (const line of lines) {
    if (NARRATION.test(line)) narrated++;
  }
  return narrated >= 2;
}

/** Fraction of non-blank lines that are comments (JSDoc + line comments). */
function commentRatio(code: string): number {
  const total = codeLineCount(code);
  if (total === 0) return 0;
  return countCommentLines(code) / total;
}

// ---------------------------------------------------------------------------
// Signal definitions
// ---------------------------------------------------------------------------

type SignalContext = {
  code: string;
  /** Path of the file being scored, when known. May be undefined for ad-hoc snippets. */
  filePath?: string;
};

type SignalDef = Omit<Signal, "fired"> & {
  test: (code: string) => boolean;
  /** Returns true when this signal makes sense for the given code context.
   *  Signals that are not applicable are excluded from the denominator so
   *  the score is normalised over what is actually testable, not over all 13
   *  signals regardless of language or file size. */
  isApplicable: (ctx: SignalContext) => boolean;
};

const SIGNALS: SignalDef[] = [
  // --- Naming ---
  {
    family: "naming",
    description: "All identifiers are fully descriptive (no aux/tmp/res/idx)",
    // Weak signal: plenty of careful human code avoids short locals too.
    // It only matters as part of a wider AI cluster, never on its own.
    weight: 0.4,
    isApplicable: ({ code }) => (code.match(/\b(?:const|let|var)\s+\w+/g) ?? []).length >= 3,
    test: (code) => {
      const declarations = code.match(/\b(?:const|let|var)\s+(\w+)/g) ?? [];
      if (declarations.length < 3) return false;
      const shortNames = /\b(aux|tmp|res|idx|val|dataOk|checkUser|usrIdx)\b/;
      return !shortNames.test(code);
    },
  },
  {
    family: "naming",
    description: "Over-descriptive variable names / verbose verb-noun helpers",
    weight: 0.7,
    isApplicable: (_ctx) => true, // always testable
    test: (code) => {
      // Specific AI-favourite names.
      if (
        /\b(processData|handleResult|performOperation|executeTask|manageSomething|calculateResult|validateInput|transformData|fetchAndProcess)\b/.test(
          code
        )
      ) {
        return true;
      }
      // General pattern: many camelCase verb-noun compound identifiers. AI
      // tends to name everything `doThingWithData`; humans use shorter names.
      const verbose = (
        code.match(
          /\b(?:get|set|handle|process|create|update|delete|fetch|build|make|validate|transform|calculate|compute|initialize|generate|render|parse|format|convert|extract|apply|resolve|ensure|record|write|load|save)(?:[A-Z]\w{3,}){1,2}\b/g
        ) ?? []
      ).length;
      return verbose >= 4;
    },
  },

  // --- Structure ---
  {
    family: "structure",
    description: "All functions use arrow syntax uniformly",
    weight: 0.6,
    isApplicable: ({ code }) => countFunctions(code) >= 3,
    test: (code) => {
      const arrows = countArrowFunctions(code);
      const traditionals = countTraditionalFunctions(code);
      // Uniform arrow-only style, with enough functions to be meaningful.
      return arrows >= 3 && traditionals === 0;
    },
  },
  {
    family: "structure",
    description: "Every function uses early-return pattern (no if/else variety)",
    weight: 0.6,
    isApplicable: ({ code }) => (code.match(/\breturn\b/g) ?? []).length >= 2,
    test: (code) => {
      const earlyReturns = (
        code.match(/\breturn\b[^;]*;\s*\n\s*(?:\/\/.*\n\s*)?\}/g) ?? []
      ).length;
      const elseBlocks = (code.match(/\belse\s*\{/g) ?? []).length;
      // Early returns must actually outnumber else-blocks, not just be absent.
      return earlyReturns >= 2 && elseBlocks === 0;
    },
  },
  {
    family: "structure",
    description: "Complex operations compressed into single expressions",
    weight: 0.6,
    isApplicable: ({ code }) => code.includes("."),
    test: (code) => {
      // Chained calls two deep (a.b().c()) are extremely common in AI code and
      // rare in hand-written code. Also count long `.map(...).filter(...)`-style
      // single-line pipelines.
      const chains = (code.match(/\.\w+\([^()]*\)\.\w+\(/g) ?? []).length;
      const pipelines = (code.match(/\w+\([^()]*\)\.(?:map|filter|reduce|then|catch|forEach)\(/g) ?? [])
        .length;
      return chains + pipelines >= 2;
    },
  },
  {
    family: "structure",
    description: "Dense single-line arrow bodies (implicit return everywhere)",
    weight: 0.5,
    isApplicable: ({ code }) => countFunctions(code) >= 3,
    test: (code) => {
      // `const x = (…) => expression;` on one line with no block — AI loves
      // these uniform one-liners; humans mix in multi-line bodies.
      const inlineArrows = (
        code.match(/=\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?!\{)[^;\n]{4,};/g) ?? []
      ).length;
      const blockArrows = countArrowFunctions(code);
      return inlineArrows >= 3 && inlineArrows >= blockArrows;
    },
  },

  // --- Comments ---
  {
    family: "comments",
    description: "Comments narrate what the code plainly does",
    weight: 0.9,
    isApplicable: ({ code }) => /\/\/|\/\*/.test(code),
    test: (code) => hasNarratingComments(code),
  },
  {
    family: "comments",
    description: "Every function has a JSDoc block",
    weight: 0.7,
    isApplicable: ({ code }) => countFunctions(code) >= 2,
    test: (code) => {
      const functions = countFunctions(code);
      const jsdocBlocks = countJsDocBlocks(code);
      return functions >= 2 && jsdocBlocks >= Math.ceil(functions / 2);
    },
  },
  {
    family: "comments",
    description: "High comment density (documentation on everything)",
    weight: 0.6,
    isApplicable: ({ code }) => codeLineCount(code) >= 20,
    test: (code) => {
      // AI code tends to be over-commented relative to human code. Above ~20%
      // comment lines in a real source file is unusually high.
      return commentRatio(code) >= 0.2;
    },
  },

  // --- Error handling ---
  {
    family: "error-handling",
    description: "catch blocks rethrow with a custom message / full logging",
    // Good practice, not an AI tell — kept weak so it cannot flag healthy code.
    weight: 0.4,
    isApplicable: ({ code }) => countCatchBlocks(code) >= 1,
    test: (code) => {
      const catchBlocks = countCatchBlocks(code);
      if (catchBlocks < 1) return false;
      // A plain `catch (e) { console.error(e); }` or bare return is the human
      // norm; AI tends to wrap everything in `throw new Error(\`...${e}\`)`.
      const richHandlers = (
        code.match(/catch\s*\([^)]*\)\s*\{[^}]*(?:throw new|logger\.|console\.(?:error|warn)\(|new \w*Error)/g) ??
        []
      ).length;
      return richHandlers >= 1 && richHandlers >= catchBlocks;
    },
  },
  {
    family: "error-handling",
    description: "Every async function wrapped in try/catch",
    // Also good practice rather than an AI tell — weak on purpose.
    weight: 0.45,
    isApplicable: ({ code }) => countAsyncFunctions(code) >= 2,
    test: (code) => {
      const asyncFns = countAsyncFunctions(code);
      const tryCatch = countTryBlocks(code);
      return asyncFns >= 2 && tryCatch >= asyncFns;
    },
  },

  // --- Abstraction ---
  {
    family: "abstraction",
    description: "All repeated logic extracted into helpers immediately",
    weight: 0.5,
    isApplicable: ({ code }) => countFunctions(code) >= 3,
    test: (code) => {
      const todoExtract = /TODO.*extract|TODO.*helper|TODO.*refactor/i.test(code);
      const helpers = (
        code.match(/\b(?:function|const)\s+\w*[Hh]elper\w*/g) ?? []
      ).length;
      // Also: a very high functions-per-line ratio suggests everything was
      // split into small single-purpose helpers (an AI habit).
      const fns = countFunctions(code);
      const dense = fns / Math.max(codeLineCount(code) / 15, 1) > 1.2;
      return !todoExtract && (helpers >= 2 || dense);
    },
  },
  {
    family: "abstraction",
    description: "Interface/type defined for every small payload",
    weight: 0.5,
    isApplicable: ({ code, filePath }) =>
      /\binterface\b/.test(code) || isTypeScriptPath(filePath),
    test: (code) => {
      if (!/\binterface\b/.test(code)) return false;
      const interfaces = countInterfaces(code);
      const linesOfCode = codeLineCount(code);
      return linesOfCode > 0 && interfaces / Math.max(linesOfCode / 40, 1) > 1;
    },
  },

  // --- Uniformity ---
  {
    family: "uniformity",
    description: "Naming convention 100% consistent across all scopes",
    weight: 0.5,
    isApplicable: ({ code }) => (code.match(/\b(?:const|let|var|def|func)\s+\w+/g) ?? []).length >= 4,
    test: (code) => {
      const declarations = (code.match(/\b(?:const|let|var)\s+(\w+)/g) ?? []).map(
        (d) => d.replace(/.*\s/, "")
      );
      if (declarations.length < 4) return false;
      // Fully consistent camelCase with essentially no snake_case and nearly
      // no single-letter locals. Allow one or two short names in a big file.
      const camel = declarations.filter((d) => /^[a-z][a-zA-Z0-9]*$/.test(d)).length;
      const snake = declarations.filter((d) => /_/.test(d)).length;
      const single = declarations.filter((d) => d.length === 1).length;
      return camel / declarations.length >= 0.9 && snake === 0 && single <= 1;
    },
  },
  {
    family: "uniformity",
    description: "All functions follow identical structural pattern",
    weight: 0.6,
    isApplicable: ({ code }) => countFunctions(code) >= 3,
    test: (code) => {
      // Look at the first non-blank line of each function body for a repeated
      // guard shape (`if (!x) {`) — AI applies the same guard to everything.
      const lines = code.split("\n");
      let bodies = 0;
      let guarded = 0;
      for (let i = 0; i < lines.length; i++) {
        const isFn =
          /\bfunction\s+\w+|=>\s*\{|=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/.test(lines[i]);
        if (!isFn) continue;
        bodies++;
        const next = (lines[i + 1] ?? "").trim();
        const after = (lines[i + 2] ?? "").trim();
        if (/^if\s*\(\s*!/.test(next) || /^if\s*\(\s*!/.test(after)) guarded++;
      }
      return bodies >= 3 && guarded / bodies >= 0.6;
    },
  },
];

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Reference weight for the saturating score curve.
 *
 * AI-generated code does not fire *every* signal — it fires a correlated
 * *cluster* of them at once (naming + structure + comments + uniformity).
 * Dividing the fired weight by the total applicable weight therefore has a
 * hard ceiling around 0.45 in practice, which is below any usable threshold:
 * a file could be textbook AI slop and still report "ok".
 *
 * Instead we map the fired weight through `1 - e^(-w / REF)`, which rises
 * quickly for the first few signals and then saturates. REF is tuned so that a
 * realistic AI cluster (~3.5–4.5 total weight) lands in the 0.75–0.85 band,
 * while genuinely human code (0–1 weak signals) stays well under 0.35.
 */
const SCORE_REFERENCE_WEIGHT = 2.5;

export function detectAI(code: string, filePath?: string): DetectorResult {
  const ctx: SignalContext = { code, filePath };

  const signals: Signal[] = SIGNALS.map((s) => ({
    family: s.family,
    description: s.description,
    weight: s.weight,
    // only evaluate test() when the signal is applicable to this code
    fired: s.isApplicable(ctx) ? s.test(code) : false,
  }));

  const firedWeight = signals
    .filter((s) => s.fired)
    .reduce((acc, s) => acc + s.weight, 0);

  // No signal fired at all → genuinely nothing to report.
  if (firedWeight === 0) {
    return { score: 0, signals };
  }

  // Score a single weak signal low (~0.15) but never a flat 0. The old code
  // forced score=0 whenever firedWeight < 0.6, which meant a real AI file that
  // happened to trip only one weak signal reported "0% — no AI signals", i.e.
  // the worst possible output: it reads as "this is definitely human". The
  // saturating curve already keeps a lone weak signal well below any usable
  // threshold, so the hard gate is unnecessary and actively harmful.
  const score = Math.min(1 - Math.exp(-firedWeight / SCORE_REFERENCE_WEIGHT), 1);

  return { score, signals };
}

/** True for files the TypeScript signals (interfaces, typed payloads) apply to. */
export function isTypeScriptPath(filePath?: string): boolean {
  if (!filePath) return false;
  return /\.(?:ts|tsx|mts|cts)$/i.test(filePath);
}

/**
 * Count the changed lines in a unified diff (added + removed, ignoring the
 * `+++`/`---` hunk headers). Used to skip trivially small changes.
 */
export function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) count++;
  }
  return count;
}

/** Extract only the added lines (+) from a unified diff chunk. */
export function extractAddedLines(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}
