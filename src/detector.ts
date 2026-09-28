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

type SignalDef = Omit<Signal, "fired"> & { test: (code: string) => boolean };

const SIGNALS: SignalDef[] = [
  // --- Naming ---
  {
    family: "naming",
    description: "All identifiers are fully descriptive (no aux/tmp/res/idx)",
    weight: 0.8,
    test: (code) => {
      // look for variable declarations; check if any use short pragmatic names
      const declarations = code.match(/\b(?:const|let|var)\s+(\w+)/g) ?? [];
      if (declarations.length < 3) return false;
      const shortNames = /\b(aux|tmp|res|idx|val|dataOk|checkUser|usrIdx)\b/;
      return !shortNames.test(code) && declarations.length >= 3;
    },
  },
  {
    family: "naming",
    description: "Over-descriptive variable names (resultadoFinal, processData, handleResult)",
    weight: 0.9,
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
    test: (code) => {
      const arrows = (code.match(/=>\s*[{(]/g) ?? []).length;
      const traditionals = (code.match(/^function\s+\w+/gm) ?? []).length;
      // pure arrow uniformity with no traditional functions in multi-function file
      return arrows >= 3 && traditionals === 0;
    },
  },
  {
    family: "structure",
    description: "Every function uses early-return pattern (no if/else variety)",
    weight: 0.7,
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
    test: (code) => {
      // chained method calls longer than 3 levels without intermediate vars
      const longChains = (code.match(/\.\w+\(.*\)\.\w+\(.*\)\.\w+\(/g) ?? []).length;
      return longChains >= 2;
    },
  },

  // --- Comments ---
  {
    family: "comments",
    description: "Comments describe what the code does (obvious narration)",
    weight: 0.9,
    test: (code) => {
      const obviousComments =
        /\/\/\s*(This function|This method|Returns the|Gets the|Sets the|Handles the|Checks if|Validates|Initializes|Creates a new|Iterates|Loops through)/i;
      return obviousComments.test(code);
    },
  },
  {
    family: "comments",
    description: "Every function has a JSDoc block",
    weight: 0.7,
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
    test: (code) => {
      const catchBlocks = (code.match(/catch\s*\([^)]*\)\s*\{/g) ?? []).length;
      if (catchBlocks < 2) return false;
      const simpleHandlers = (
        code.match(/catch\s*\([^)]*\)\s*\{\s*(?:console\.\w+|return null|return;)/g) ?? []
      ).length;
      // if NO catch block is simple, all are exhaustive → AI pattern
      return simpleHandlers === 0 && catchBlocks >= 2;
    },
  },
  {
    family: "error-handling",
    description: "Every async function wrapped in try/catch",
    weight: 0.75,
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
    test: (code) => {
      // no TODO: extract comments; lots of helper functions
      const todoExtract = /TODO.*extract|TODO.*helper|TODO.*refactor/i.test(code);
      const helpers = (code.match(/(?:function|const)\s+\w*[Hh]elper\w*/g) ?? []).length;
      return !todoExtract && helpers >= 2;
    },
  },
  {
    family: "abstraction",
    description: "Interface defined for every small payload or inline type",
    weight: 0.6,
    test: (code) => {
      const interfaces = (code.match(/\binterface\s+\w+/g) ?? []).length;
      const linesOfCode = code.split("\n").filter((l) => l.trim().length > 0).length;
      // more than 1 interface per 20 lines is over-engineering territory
      return linesOfCode > 0 && interfaces / (linesOfCode / 20) > 1.5;
    },
  },

  // --- Uniformity ---
  {
    family: "uniformity",
    description: "Naming convention 100% consistent across all scopes",
    weight: 0.5,
    test: (code) => {
      // mix of naming styles is a human signal; pure camelCase everywhere is AI
      const hasCamel = /\b[a-z][a-zA-Z0-9]+\b/.test(code);
      const hasShort = /\b(i|j|k|n|x|y|e|ok|id|fn|cb)\b/.test(code);
      // if it's all camelCase with zero short vars and zero single-letter loop vars → suspicious
      return hasCamel && !hasShort;
    },
  },
  {
    family: "uniformity",
    description: "All functions follow identical structural pattern",
    weight: 0.7,
    test: (code) => {
      // check if every function block opens the same way (validate → transform → return)
      const fnBodies = code.match(/(?:function\s+\w+|=>\s*)\{([^}]{20,})\}/g) ?? [];
      if (fnBodies.length < 3) return false;
      // rough check: all start with if (!
      const guardPattern = fnBodies.filter((b) => /\{\s*if\s*\(!/.test(b));
      return guardPattern.length === fnBodies.length;
    },
  },
];

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export function detectAI(code: string): DetectorResult {
  const signals: Signal[] = SIGNALS.map((s) => ({
    family: s.family,
    description: s.description,
    weight: s.weight,
    fired: s.test(code),
  }));

  const fired = signals.filter((s) => s.fired);
  const totalWeight = signals.reduce((acc, s) => acc + s.weight, 0);
  const firedWeight = fired.reduce((acc, s) => acc + s.weight, 0);

  const score = totalWeight > 0 ? Math.min(firedWeight / totalWeight, 1) : 0;

  return { score, signals };
}

/** Extract only the added lines (+) from a unified diff chunk. */
export function extractAddedLines(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}
