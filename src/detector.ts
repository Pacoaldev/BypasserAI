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
    weight: 0.8,
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
    description: "Over-descriptive variable names (processData, handleResult, performOperation)",
    weight: 0.9,
    isApplicable: (_ctx) => true, // always testable
    test: (code) =>
      /\b(processData|handleResult|performOperation|executeTask|manageSomething|calculateResult|validateInput|transformData|fetchAndProcess)\b/.test(
        code
      ),
  },

  // --- Structure ---
  {
    family: "structure",
    description: "All functions use arrow syntax uniformly",
    weight: 0.6,
    isApplicable: ({ code }) => (code.match(/(?:=>\s*[{(]|^function\s+\w+)/gm) ?? []).length >= 3,
    test: (code) => {
      const arrows = (code.match(/=>\s*[{(]/g) ?? []).length;
      const traditionals = (code.match(/^function\s+\w+/gm) ?? []).length;
      return arrows >= 3 && traditionals === 0;
    },
  },
  {
    family: "structure",
    description: "Every function uses early-return pattern (no if/else variety)",
    weight: 0.7,
    isApplicable: ({ code }) => (code.match(/\breturn\b/g) ?? []).length >= 2,
    test: (code) => {
      const earlyReturns = (code.match(/\breturn\b.*;\s*\n\s*(?:\/\/.*\n\s*)?\}/gm) ?? []).length;
      const elseBlocks = (code.match(/\belse\s*\{/g) ?? []).length;
      return earlyReturns >= 2 && elseBlocks === 0;
    },
  },
  {
    family: "structure",
    description: "Complex operations compressed into single expressions",
    weight: 0.7,
    isApplicable: ({ code }) => code.includes("."),
    test: (code) => {
      const longChains = (code.match(/\.\w+\(.*\)\.\w+\(.*\)\.\w+\(/g) ?? []).length;
      return longChains >= 2;
    },
  },

  // --- Comments ---
  {
    family: "comments",
    description: "Comments describe what the code does (obvious narration)",
    weight: 0.9,
    isApplicable: ({ code }) => /\/\/|\/\*/.test(code),
    test: (code) =>
      /\/\/\s*(This function|This method|Returns the|Gets the|Sets the|Handles the|Checks if|Validates|Initializes|Creates a new|Iterates|Loops through)/i.test(
        code
      ),
  },
  {
    family: "comments",
    description: "Every function has a JSDoc block",
    weight: 0.7,
    isApplicable: ({ code }) => {
      const fns = (code.match(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\()/g) ?? []).length;
      return fns >= 2;
    },
    test: (code) => {
      const jsdocBlocks = (code.match(/\/\*\*[\s\S]*?\*\//g) ?? []).length;
      const functions = (
        code.match(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\()/g) ?? []
      ).length;
      return functions >= 2 && jsdocBlocks >= functions;
    },
  },

  // --- Error handling ---
  {
    family: "error-handling",
    description: "Every catch block has custom error class or full logging",
    weight: 0.8,
    isApplicable: ({ code }) => (code.match(/catch\s*\([^)]*\)\s*\{/g) ?? []).length >= 2,
    test: (code) => {
      const catchBlocks = (code.match(/catch\s*\([^)]*\)\s*\{/g) ?? []).length;
      if (catchBlocks < 2) return false;
      const simpleHandlers = (
        code.match(/catch\s*\([^)]*\)\s*\{\s*(?:console\.\w+|return null|return;)/g) ?? []
      ).length;
      return simpleHandlers === 0;
    },
  },
  {
    family: "error-handling",
    description: "Every async function wrapped in try/catch",
    weight: 0.75,
    isApplicable: ({ code }) =>
      (code.match(/async\s+(?:function\s+\w+|\w+\s*=>|\(\w*\)\s*=>)/g) ?? []).length >= 2,
    test: (code) => {
      const asyncFns = (code.match(/async\s+(?:function\s+\w+|\w+\s*=>|\(\w*\)\s*=>)/g) ?? []).length;
      const tryCatch = (code.match(/try\s*\{/g) ?? []).length;
      return asyncFns >= 2 && tryCatch >= asyncFns;
    },
  },

  // --- Abstraction ---
  {
    family: "abstraction",
    description: "All repeated logic extracted into helpers immediately",
    weight: 0.65,
    isApplicable: ({ code }) =>
      (code.match(/(?:function|const)\s+\w+/g) ?? []).length >= 3,
    test: (code) => {
      const todoExtract = /TODO.*extract|TODO.*helper|TODO.*refactor/i.test(code);
      const helpers = (code.match(/(?:function|const)\s+\w*[Hh]elper\w*/g) ?? []).length;
      return !todoExtract && helpers >= 2;
    },
  },
  {
    family: "abstraction",
    description: "Interface defined for every small payload or inline type",
    weight: 0.6,
    // Applicable to TypeScript signals: either the file is .ts/.tsx (path known)
    // or an `interface` keyword is already present in the snippet.
    isApplicable: ({ code, filePath }) =>
      /\binterface\b/.test(code) || isTypeScriptPath(filePath),
    test: (code) => {
      const interfaces = (code.match(/\binterface\s+\w+/g) ?? []).length;
      const linesOfCode = code.split("\n").filter((l) => l.trim().length > 0).length;
      return linesOfCode > 0 && interfaces / (linesOfCode / 20) > 1.5;
    },
  },

  // --- Uniformity ---
  {
    family: "uniformity",
    description: "Naming convention 100% consistent across all scopes",
    weight: 0.5,
    isApplicable: ({ code }) => (code.match(/\b(?:const|let|var|def|func)\s+\w+/g) ?? []).length >= 4,
    test: (code) => {
      const hasCamel = /\b[a-z][a-zA-Z0-9]+\b/.test(code);
      const hasShort = /\b(i|j|k|n|x|y|e|ok|id|fn|cb)\b/.test(code);
      return hasCamel && !hasShort;
    },
  },
  {
    family: "uniformity",
    description: "All functions follow identical structural pattern",
    weight: 0.7,
    isApplicable: ({ code }) =>
      (code.match(/(?:function\s+\w+|=>\s*\{)/g) ?? []).length >= 3,
    test: (code) => {
      const fnBodies = code.match(/(?:function\s+\w+|=>\s*)\{([^}]{20,})\}/g) ?? [];
      if (fnBodies.length < 3) return false;
      const guardPattern = fnBodies.filter((b) => /\{\s*if\s*\(!/.test(b));
      return guardPattern.length === fnBodies.length;
    },
  },
];

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export function detectAI(code: string, filePath?: string): DetectorResult {
  const ctx: SignalContext = { code, filePath };

  const signals: Signal[] = SIGNALS.map((s) => ({
    family: s.family,
    description: s.description,
    weight: s.weight,
    // only evaluate test() when the signal is applicable to this code
    fired: s.isApplicable(ctx) ? s.test(code) : false,
  }));

  // normalise over applicable signals only — signals that cannot fire in this
  // context don't penalise the score
  const applicable = SIGNALS.filter((s) => s.isApplicable(ctx));
  const applicableWeight = applicable.reduce((acc, s) => acc + s.weight, 0);
  const firedWeight = signals
    .filter((s) => s.fired)
    .reduce((acc, s) => acc + s.weight, 0);

  const score = applicableWeight > 0 ? Math.min(firedWeight / applicableWeight, 1) : 0;

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
