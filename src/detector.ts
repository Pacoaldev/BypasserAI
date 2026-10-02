/**
 * Heuristic detector for AI-generated code patterns.
 *
 * Scores a code snippet or file from 0 (likely human) to 1 (likely AI).
 * Does NOT call any external API — fully deterministic, usable in CI for free.
 *
 * ## Language-agnostic by design
 *
 * The detector used to be written against JavaScript only: every helper
 * matched `function`, `const x =`, `=>` or `/** ... *\/`. On Python, Go or Rust
 * that made *every* signal inapplicable, so a 100%-AI Python file scored a
 * flat 0% and was never humanized — the exact failure this tool exists to
 * prevent ("Cursor says 100% AI, bypasser says 0%").
 *
 * Everything now goes through a small **language profile** resolved from the
 * file extension (or sniffed from the source when there is no path). The
 * profile knows how each language spells the things the detector cares about:
 * function declarations, doc comments, variable declarations, guards, etc.
 * A signal never hard-codes a single language's syntax.
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
// Language profiles
//
// A profile describes how to recognise a language's surface syntax without a
// full parser. It is deliberately regex/line based: robust enough across real
// files, cheap enough to run on every commit, and dependency-free.
// ---------------------------------------------------------------------------

export type LanguageId =
  | "javascript"
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "cpp"
  | "ruby"
  | "php"
  | "unknown";

export interface LanguageProfile {
  id: LanguageId;
  /** `<style>` marker used only for readability/debugging. */
  name: string;
  /** Matches a function-like declaration anywhere in the source. */
  fnDecl: RegExp;
  /** Matches an async function-like declaration (subset of fnDecl). */
  asyncFnDecl: RegExp;
  /** Matches a variable/constant declaration and captures its name. */
  varDecl: RegExp;
  /** Matches an `if` guard whose condition starts with a negation (`if (!x)`). */
  negatedGuard: RegExp;
  /** Matches an `else` branch opener. */
  elseBlock: RegExp;
  /** Matches a `catch`/recover-style handler opener. */
  catchBlock: RegExp;
  /** Matches a `try`/protected-block opener. */
  tryBlock: RegExp;
  /** Matches a docstring or JSDoc-style documentation block. */
  docBlock: RegExp;
  /** True for languages where indentation defines block structure (Python). */
  indentBased: boolean;
  /** Line-comment prefixes for this language. */
  lineComment: string[];
}

const JS_TS_COMMON = {
  // Function-like declarations. Covers `function f`, `export async function f`,
  // `const/let/var f = (…) =>` / `= async (…) =>` / `= function`, and object
  // literal methods (`name: (…) =>`). The `export`/`default` prefixes are
  // consumed so `export const foo = () =>` counts (it did not before, which
  // under-counted React/TS files and made several signals inapplicable).
  fnDecl:
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>))|\b\w+\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g,
  asyncFnDecl: /\basync\s+(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)|\b(?:const|let|var)\s+\w+\s*=\s*async\s*\(/g,
  varDecl: /\b(?:const|let|var)\s+(\w+)/g,
  negatedGuard: /^\s*\}?\s*if\s*\(\s*!/,
  elseBlock: /\belse\s*\{/g,
  catchBlock: /\bcatch\s*(?:\([^)]*\))?\s*\{/g,
  tryBlock: /\btry\s*\{/g,
  docBlock: /\/\*\*[\s\S]*?\*\//g,
  indentBased: false,
  lineComment: ["//"],
};

const PROFILES: Record<LanguageId, LanguageProfile> = {
  javascript: {
    id: "javascript",
    name: "JavaScript",
    ...JS_TS_COMMON,
  },
  typescript: {
    id: "typescript",
    name: "TypeScript",
    ...JS_TS_COMMON,
  },
  python: {
    id: "python",
    name: "Python",
    // `def name(` and `async def name(` at any indentation.
    fnDecl: /^[ \t]*(?:async\s+)?def\s+\w+\s*\(/gm,
    asyncFnDecl: /^[ \t]*async\s+def\s+\w+\s*\(/gm,
    varDecl: /^[ \t]*(\w+)\s*(?::[^=\n]+)?=/gm,
    negatedGuard: /^\s*if\s+not\s+/,
    elseBlock: /^[ \t]*else\s*:/gm,
    catchBlock: /^[ \t]*except\b[^:\n]*:/gm,
    tryBlock: /^[ \t]*try\s*:/gm,
    // A triple-quoted string, the Python equivalent of JSDoc.
    docBlock: /(?:"""[\s\S]*?"""|'''[\s\S]*?''')/g,
    indentBased: true,
    lineComment: ["#"],
  },
  go: {
    id: "go",
    name: "Go",
    fnDecl: /^[ \t]*func\s+(?:\([^)]*\)\s*)?\w+\s*\(/gm,
    asyncFnDecl: /\bgo\s+func\b|\bgo\s+\w+\(/g,
    varDecl: /\b(?:var|const)\s+(\w+)|\b(\w+)\s*:?=/gm,
    negatedGuard: /^\s*if\s+![\w(]/,
    elseBlock: /\}\s*else\s*\{/g,
    catchBlock: /\brecover\(\)/g,
    tryBlock: /\bdefer\s+func\s*\(/g,
    // Doc comments: a `//` block directly above a declaration.
    docBlock: /(?:^[ \t]*\/\/.*\n)+[ \t]*(?:func|type|var|const)\s/gm,
    indentBased: false,
    lineComment: ["//"],
  },
  rust: {
    id: "rust",
    name: "Rust",
    fnDecl: /^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+\w+/gm,
    asyncFnDecl: /\basync\s+fn\s+\w+/g,
    varDecl: /\b(?:let|const|static)\s+(?:mut\s+)?(\w+)/g,
    negatedGuard: /^\s*if\s+!/,
    elseBlock: /\}\s*else\s*\{/g,
    catchBlock: /\b(?:unwrap_or|map_err|expect)\(|\bmatch\b[^\n]*Result/g,
    tryBlock: /\b(?:if\s+let\s+Ok|\?;)/g,
    docBlock: /(?:^[ \t]*\/\/\/.*\n)+|(?:\/\/![\s\S]*?\n)+/gm,
    indentBased: false,
    lineComment: ["//"],
  },
  java: {
    id: "java",
    name: "Java",
    fnDecl:
      /^[ \t]*(?:public|private|protected|static|final|synchronized|\s)*[\w<>[\],\s]+\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\{/gm,
    asyncFnDecl: /@Async\b|CompletableFuture/g,
    varDecl: /\b(?:final\s+)?[\w<>[\]]+\s+(\w+)\s*=/g,
    negatedGuard: /^\s*if\s*\(\s*!/,
    elseBlock: /\}\s*else\s*\{/g,
    catchBlock: /\bcatch\s*\([^)]*\)\s*\{/g,
    tryBlock: /\btry\s*\{/g,
    docBlock: /\/\*\*[\s\S]*?\*\//g,
    indentBased: false,
    lineComment: ["//"],
  },
  csharp: {
    id: "csharp",
    name: "C#",
    fnDecl:
      /^[ \t]*(?:public|private|protected|internal|static|async|override|virtual|\s)*[\w<>[\],\s]+\s+\w+\s*\([^)]*\)\s*\{/gm,
    asyncFnDecl: /\basync\s+Task\b|\basync\s+void\b/g,
    varDecl: /\bvar\s+(\w+)|\b(?:int|string|bool|double|float|long)\s+(\w+)\s*=/g,
    negatedGuard: /^\s*if\s*\(\s*!/,
    elseBlock: /\}\s*else\s*\{/g,
    catchBlock: /\bcatch\s*(?:\([^)]*\))?\s*\{/g,
    tryBlock: /\btry\s*\{/g,
    docBlock: /\/\/\/[\s\S]*?(?=\n\s*[^\s/])|\/\*\*[\s\S]*?\*\//g,
    indentBased: false,
    lineComment: ["//"],
  },
  cpp: {
    id: "cpp",
    name: "C/C++",
    fnDecl:
      /^[ \t]*(?:static|inline|virtual|constexpr|explicit|\s)*[\w:*&<>[\],\s]+\s+\w+\s*\([^)]*\)\s*(?:const)?\s*\{/gm,
    asyncFnDecl: /\bstd::async\b|\bco_await\b/g,
    varDecl: /\b(?:auto|int|long|double|float|char|bool|std::\w+)\s+(\w+)\s*=/g,
    negatedGuard: /^\s*if\s*\(\s*!/,
    elseBlock: /\}\s*else\s*\{/g,
    catchBlock: /\bcatch\s*\([^)]*\)\s*\{/g,
    tryBlock: /\btry\s*\{/g,
    docBlock: /\/\*\*[\s\S]*?\*\/|(?:^[ \t]*\/\/\/.*\n)+/gm,
    indentBased: false,
    lineComment: ["//"],
  },
  ruby: {
    id: "ruby",
    name: "Ruby",
    fnDecl: /^[ \t]*def\s+[\w.?!=]+/gm,
    asyncFnDecl: /\bAsync\b|\bawait\b/g,
    varDecl: /^[ \t]*(\w+)\s*=/gm,
    negatedGuard: /^\s*(?:unless\s+|return\s+unless\s+)/,
    elseBlock: /^[ \t]*else\b/gm,
    catchBlock: /^[ \t]*rescue\b/gm,
    tryBlock: /^[ \t]*begin\b/gm,
    docBlock: /(?:^[ \t]*#.*\n){2,}/gm,
    indentBased: true,
    lineComment: ["#"],
  },
  php: {
    id: "php",
    name: "PHP",
    fnDecl: /^[ \t]*(?:public|private|protected|static|\s)*function\s+\w+\s*\(/gm,
    asyncFnDecl: /\basync\s+function\b|\bawait\b/g,
    varDecl: /\$(\w+)\s*=/g,
    negatedGuard: /^\s*if\s*\(\s*!/,
    elseBlock: /\}\s*else\s*\{/g,
    catchBlock: /\bcatch\s*\([^)]*\)\s*\{/g,
    tryBlock: /\btry\s*\{/g,
    docBlock: /\/\*\*[\s\S]*?\*\//g,
    indentBased: false,
    lineComment: ["//", "#"],
  },
  unknown: {
    id: "unknown",
    name: "Unknown",
    fnDecl:
      /\b(?:function\s+\w+|def\s+\w+|func\s+\w+|fn\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g,
    asyncFnDecl: /\basync\s+(?:function|def|fn)\b/g,
    varDecl: /\b(?:const|let|var|def|val|mut)\s+(\w+)/g,
    negatedGuard: /^\s*if\s*\(?\s*!/,
    elseBlock: /\belse\s*[:{]?/g,
    catchBlock: /\b(?:catch|except|rescue)\b/g,
    tryBlock: /\b(?:try|begin)\b/g,
    docBlock: /\/\*\*[\s\S]*?\*\/|"""[\s\S]*?"""/g,
    indentBased: false,
    lineComment: ["//", "#"],
  },
};

const EXT_TO_LANG: Record<string, LanguageId> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  h: "cpp",
  rb: "ruby",
  php: "php",
};

/** Resolve the language profile for a file path, sniffing the source as a fallback. */
export function resolveLanguage(filePath?: string, code = ""): LanguageProfile {
  if (filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const id = EXT_TO_LANG[ext];
    if (id) return PROFILES[id];
  }
  return PROFILES[sniffLanguage(code)];
}

/**
 * Best-effort language sniff for path-less snippets (tests, `rewrite` on a
 * piped string). Looks for a few unambiguous keywords before giving up.
 */
function sniffLanguage(code: string): LanguageId {
  // Python: a `from`/`def`/`class` header or a triple-quoted string, AND a
  // line ending in `:` (block header). The parentheses pin the intended
  // precedence — without them `&&` binds tighter than the `|` alternation and
  // the `:` guard would only apply to the `"""` branch.
  const looksPythonish =
    /^\s*(?:import\s+\w+\s*\n)?\s*(?:from|def|class)\s+\w+|"""/m.test(code) &&
    /:\s*$/m.test(code);
  if (looksPythonish) {
    if (/\bdef\s+\w+\s*\(|\bself\b|:$/m.test(code)) return "python";
  }
  if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\(|\bgo\s+func\b/.test(code)) return "go";
  if (/\bfn\s+\w+\s*\(|\blet\s+mut\b|\bimpl\b|\bpub\s+fn\b/.test(code)) return "rust";
  if (/\bpublic\s+class\b|\bprivate\s+\w+\s*\(|\bSystem\.out\b/.test(code)) return "java";
  if (/\bnamespace\s+\w+|\busing\s+System\b|\bConsole\.Write/.test(code)) return "csharp";
  if (/\bdef\s+\w+|\bend\b\s*$|\bputs\b|\brequire\b/m.test(code) && !/\{/.test(code.slice(0, 200)))
    return "ruby";
  if (/<\?php|\$\w+\s*=/.test(code)) return "php";
  if (/\bimport\b|\bexport\b|\bconst\b|\bfunction\b|=>/.test(code)) {
    if (/:\s*(?:string|number|boolean)\b|interface\s+\w+|\btype\s+\w+\s*=/.test(code))
      return "typescript";
    return "javascript";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Structural helpers — all take a resolved profile
// ---------------------------------------------------------------------------

/** Count function-like declarations for the language. */
function countFunctions(code: string, p: LanguageProfile): number {
  const seen = new Set<number>();
  const re = new RegExp(p.fnDecl.source, p.fnDecl.flags.includes("g") ? p.fnDecl.flags : p.fnDecl.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    seen.add(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return seen.size;
}

/** Count async function-like declarations. */
function countAsyncFunctions(code: string, p: LanguageProfile): number {
  return matchCount(code, p.asyncFnDecl);
}

/** Count `try`-style protected blocks. */
function countTryBlocks(code: string, p: LanguageProfile): number {
  return matchCount(code, p.tryBlock);
}

/** Count `catch`/recover-style handlers. */
function countCatchBlocks(code: string, p: LanguageProfile): number {
  return matchCount(code, p.catchBlock);
}

/** Count doc comments / docstrings. */
function countDocBlocks(code: string, p: LanguageProfile): number {
  return matchCount(code, p.docBlock);
}

/**
 * Detect the fingerprint of AI-generated JSX/TSX: many utility-class strings
 * * (Tailwind) that are long, and/or a high density of JSX elements. A human
 * writing a component by hand tends to hand-write CSS or reuse a class or two;
 * AI emits long, uniform utility-class soups on nearly every element. This
 * applies only to files that actually contain JSX.
 */
function hasUniformJsxClasses(code: string): boolean {
  const classAttrs = (code.match(/class(?:Name)?\s*=\s*["'`{]/g) ?? []).length;
  if (classAttrs > 0) {
    const longClasses = (
      code.match(/class(?:Name)?\s*=\s*["'][^"']{40,}["']/g) ?? []
    ).length;
    // Long utility-class strings on most elements is the AI Tailwind tell.
    if (longClasses >= 3 && longClasses / classAttrs >= 0.4) return true;
  }
  // High JSX element density with no other prose is a weaker but real signal.
  const jsxElements = (code.match(/<[a-z][a-zA-Z0-9.]*\s[^>]*>/g) ?? []).length;
  const jsxLines = (code.match(/^\s*<[A-Za-z]/gm) ?? []).length;
  return jsxElements >= 8 && jsxLines >= 6;
}

/**
 * Detect over-exhaustive static typing, an AI tell in TypeScript and Python:
 * full type annotations on every parameter and return (including the obvious
 * ones) rather than the pragmatic partial typing a human writes.
 */
function hasExhaustiveAnnotations(code: string, p: LanguageProfile): boolean {
  if (p.id === "python") {
    const defs = countFunctions(code, p);
    if (defs < 3) return false;
    const annotated = (
      code.match(/^[ \t]*(?:async\s+)?def\s+\w+\s*\([^)]*:\s*\w+[^)]*\)\s*(?:->\s*[\w[\], |]+)?/gm) ?? []
    ).length;
    const withReturn = (code.match(/\)\s*->\s*[\w[\], |]+:/g) ?? []).length;
    // Nearly every def carries parameter types AND return types.
    return annotated >= defs * 0.8 && withReturn >= defs * 0.6;
  }
  if (p.id === "typescript") {
    const fns = countFunctions(code, p);
    if (fns < 3) return false;
    const typedParams = (
      code.match(/\([^)]*\w+\s*:\s*(?:string|number|boolean|\w+\[\]|Record<|Promise<|Array<|[\w.]+<)/g) ?? []
    ).length;
    const typedReturns = (code.match(/\)\s*:\s*(?:Promise<|void|string|number|boolean|[\w.]+<|[\w.]+\[\])/g) ?? []).length;
    return typedParams >= fns * 0.6 && typedReturns >= fns * 0.4;
  }
  return false;
}

/**
 * Detect the exhaustive React-hook style AI writes: `useCallback`/`useMemo`
 * with explicit dependency arrays on every helper, and `useEffect` for every
 * side effect. A human tends to inline handlers and only memoize hot paths;
 * AI wraps *everything* in `useCallback(fn, [])` and a memo. Emitting one or
 * two hooks is normal — hitting most of these patterns at once is the tell.
 */
function hasExhaustiveHooks(code: string): boolean {
  const useCallback = (code.match(/\buseCallback\s*\(/g) ?? []).length;
  const useMemo = (code.match(/\buseMemo\s*\(/g) ?? []).length;
  const useEffect = (code.match(/\buseEffect\s*\(/g) ?? []).length;
  const depsArrays = (code.match(/\},\s*\[[^\]]*\]\s*\)/g) ?? []).length;
  // Two or more memoised callbacks, or a callback + memo + effect trio, each
  // with an explicit dep array, is the AI signature.
  const memoised = useCallback + useMemo;
  return memoised >= 2 && depsArrays >= memoised - 1 && (useEffect >= 1 || memoised >= 3);
}

/**
 * Detect pervasive "modern TS idiom soup" — the lint-driven stylings AI emits
 * far more often than humans: `void somePromise();` everywhere to silence
 * floating-promise lint, and `e instanceof Error ? e.message : String(e)`
 * copied into every catch. Each is legitimate in isolation, so this is a
 * cluster signal: it only fires when the idioms appear several times.
 */
function hasModernTsIdiomSoup(code: string): boolean {
  const voidPromises = matchCount(code, /\bvoid\s+[A-Za-z_$][\w.$]*\s*\(/g);
  const errorTernaries = matchCount(
    code,
    /\binstanceof Error\s*\?\s*[\w.$]+\s*:\s*String\s*\(/g
  );
  const asConst = matchCount(code, /\bas const\b/g);
  const satisfies = matchCount(code, /\bsatisfies\s+[A-Z\w]/g);
  const promiseAll = matchCount(code, /\bPromise\.all\s*\(/g);
  const total = voidPromises + errorTernaries + asConst + satisfies + promiseAll;
  // Any single one of these is ordinary; two or more distinct usages in one
  // file is the lint-polished AI fingerprint.
  return total >= 2;
}

/** Count variable declarations and return their captured names. */
function extractDeclarationNames(code: string, p: LanguageProfile): string[] {
  const names: string[] = [];
  const re = new RegExp(p.varDecl.source, p.varDecl.flags.includes("g") ? p.varDecl.flags : p.varDecl.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    // Use the first non-undefined capture group — profiles vary in arity.
    const name = m.slice(1).find((g) => typeof g === "string" && g.length > 0);
    if (name) names.push(name);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return names;
}

function matchCount(code: string, re: RegExp): number {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (code.match(r) ?? []).length;
}

/** Non-blank line count. */
function codeLineCount(code: string): number {
  return code.split("\n").filter((l) => l.trim().length > 0).length;
}

/** Count lines whose only content is a line or block comment. */
function countCommentLines(code: string, p: LanguageProfile): number {
  let n = 0;
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (p.lineComment.some((c) => t.startsWith(c))) n++;
    else if (t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) n++;
    // Python docstring delimiters.
    else if (t === '"""' || t === "'''" || t.startsWith('"""') || t.startsWith("'''")) n++;
  }
  return n;
}

/** Fraction of non-blank lines that are comments. */
function commentRatio(code: string, p: LanguageProfile): number {
  const total = codeLineCount(code);
  if (total === 0) return 0;
  return countCommentLines(code, p) / total;
}

/**
 * Measure how *terse* the documentation is. A JSDoc/PHPDoc/docstring block
 * that fits in one or two lines is the AI shape: it restates the signature
 * (`/** Fetches the user. *\/`). A substantive human docblock explains the
 * why/edge cases and spans several lines. Returns the fraction of doc blocks
 * that are "terse" (≤2 content lines), or 0 when there are none.
 *
 * This is what separates a documented human codebase (Laravel, where every
 * method legitimately carries a docblock) from AI slop (a terse docblock on
 * *every* method).
 */
function terseDocBlockRatio(code: string, p: LanguageProfile): number {
  const re = new RegExp(
    p.docBlock.source,
    p.docBlock.flags.includes("g") ? p.docBlock.flags : p.docBlock.flags + "g"
  );
  let total = 0;
  let terse = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    total++;
    const block = m[0];
    // A block carrying structured annotations (@param/@returns/@throws, Python
    // `Args:`/`Returns:`) is *informative* documentation, not an AI
    // restatement — human codebases (Laravel, JSDoc-heavy TS) are full of
    // these. Never count them as terse.
    if (/@\w+|\b(?:Args|Returns|Raises|Parameters|Yields|Example)\s*:/.test(block)) {
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }
    const contentLines = block
      .split("\n")
      .map((l) => l.replace(/^[\s/*#"'`]+|[\s*/"'`]+$/g, "").trim())
      .filter((l) => l.length > 0);
    if (contentLines.length <= 2) terse++;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return total === 0 ? 0 : terse / total;
}

/** `interface`/`Protocol`/`struct`/`type` payload shapes. */
function countTypeDeclarations(code: string, p: LanguageProfile): number {
  switch (p.id) {
    case "typescript":
      return matchCount(code, /\b(?:interface|type)\s+\w+/g);
    case "python":
      // Payload-shaped types, not the file's main class. `@dataclass` decorators
      // and structural typing helpers are the AI payload-shape tell.
      return matchCount(code, /\b(?:Protocol|TypedDict|NamedTuple)\s+\w+|@dataclass\b/g);
    case "go":
      return matchCount(code, /\btype\s+\w+\s+(?:struct|interface)\b/g);
    case "rust":
      return matchCount(code, /\b(?:struct|enum|trait)\s+\w+/g);
    case "java":
    case "csharp":
    case "cpp":
    case "php":
    case "ruby":
      // In class-based languages the file's *primary* class is not a "small
      // payload type" — counting it makes every short human class look like an
      // AI payload shape. Only nested/extra declarations (records, enums,
      // structs) count, and only beyond the first class.
      return Math.max(
        0,
        matchCount(code, /\b(?:interface|class|struct|enum|record|trait)\s+\w+/g) - 1
      );
    default:
      return Math.max(
        0,
        matchCount(code, /\b(?:interface|class|struct|trait|type)\s+\w+/g) - 1
      );
  }
}

/**
 * Detect over-narration in comments: comments that restate what the very next
 * line of code plainly does. We look for the *pattern* — an
 * imperative/narrative sentence-starting comment — which is the hallmark of
 * AI narration regardless of comment syntax.
 */
function hasNarratingComments(code: string, p: LanguageProfile): boolean {
  // Two shapes of "AI narration":
  //  1. A short imperative comment that restates the next statement:
  //     `// Validate the input`, `// Create the client`.
  //  2. Prose that *starts* with a macro-narrator ("This function…").
  //
  // The short-imperative shape is the reliable tell. Rationale/architecture
  // comments ("// The model emits intents as a vendor-neutral envelope…") are
  // longer, contain internal punctuation, and must NOT be counted — flagging
  // them was a false positive on well-commented human code.
  const SHORT_IMPERATIVE =
    /^\s*(?:\/\/|#|\*)\s*(?:Validate|Create|Check|Handle|Get|Set|Fetch|Build|Make|Initialize|Ensure|Return|Iterate|Loop|Parse|Read|Write|Load|Save|Compute|Calculate|Convert|Transform|Process|Add|Remove|Update|Skip|Score|Fire|Wrap|Mark|Record|Apply|Install|Send|Run|Execute|Open|Close|Start|Stop|Filter|Map|Sort|Group|Merge|Split|Join|Retry|Log|Throw|Reset|Clear|Render|Draw|Register|Unregister|Attach|Detach|Bind|Unbind)\b[^\n]*$/;
  const MACRO_NARRATOR =
    /^\s*(?:\/\/|#|\*)\s*(?:This (?:function|method|class|file|module|component|hook)\b|The (?:function|code|following)\b)/;

  let narrated = 0;
  for (const line of code.split("\n")) {
    const isComment = /^\s*(?:\/\/|#|\*)/.test(line);
    if (!isComment) continue;
    const body = line.replace(/^\s*(?:\/\/|#|\*)\s?/, "").trim();
    if (MACRO_NARRATOR.test(line)) {
      narrated++;
      continue;
    }
    // Short imperative restatement: no internal sentence punctuation, and
    // genuinely short. A rationale comment runs long and/or has a period.
    if (SHORT_IMPERATIVE.test(line) && body.length <= 60 && !/[.;:]/.test(body)) {
      narrated++;
    }
  }
  // One narration line can be legitimate; two or more is the AI tell. Python's
  // `#` comments are also used for real inline notes, so require three there.
  const threshold = p.indentBased ? 3 : 2;
  return narrated >= threshold;
}

// ---------------------------------------------------------------------------
// Signal definitions
// ---------------------------------------------------------------------------

type SignalContext = {
  code: string;
  p: LanguageProfile;
  /** Path of the file being scored, when known. */
  filePath?: string;
};

type SignalDef = Omit<Signal, "fired"> & {
  test: (ctx: SignalContext) => boolean;
  /** Whether this signal is meaningful for the given code — excluded from
   *  the denominator when false so the score is normalised over what is
   *  actually testable for the language and file size. */
  isApplicable: (ctx: SignalContext) => boolean;
};

const SIGNALS: SignalDef[] = [
  // --- Naming ---
  {
    family: "naming",
    description: "All identifiers are fully descriptive (no aux/tmp/res/idx)",
    // Weak signal: plenty of careful human code avoids short locals too.
    weight: 0.4,
    isApplicable: ({ code, p }) => extractDeclarationNames(code, p).length >= 3,
    test: ({ code, p }) => {
      const names = extractDeclarationNames(code, p);
      if (names.length < 3) return false;
      const shortNames = /\b(aux|tmp|res|idx|val|dataOk|checkUser|usrIdx|n|i|j|k|x|y)\b/;
      return !shortNames.test(code);
    },
  },
  {
    family: "naming",
    description: "Over-descriptive variable names / verbose verb-noun helpers",
    weight: 0.7,
    isApplicable: () => true,
    test: ({ code }) => {
      if (
        /\b(processData|handleResult|performOperation|executeTask|manageSomething|calculateResult|validateInput|transformData|fetchAndProcess)\b/.test(
          code
        )
      ) {
        return true;
      }
      // Verb-noun compounds across JS and Python naming conventions:
      // `doThingWithData`, `process_data`, `handle_result`.
      const verbose = (
        code.match(
          /\b(?:get|set|handle|process|create|update|delete|fetch|build|make|validate|transform|calculate|compute|initialize|generate|render|parse|format|convert|extract|apply|resolve|ensure|record|write|load|save)(?:[A-Z]\w{3,}|_\w{3,})\b/g
        ) ?? []
      ).length;
      return verbose >= 4;
    },
  },

  // --- Structure ---
  {
    family: "structure",
    description: "Uniform function-declaration style (no variety)",
    weight: 0.55,
    isApplicable: ({ code, p }) => countFunctions(code, p) >= 3,
    test: ({ code, p }) => {
      // Python: every function is a one-liner passthrough or every function is
      // `async def`. JS/TS: uniform arrow-only style. We detect the *lack of
      // variety* in how functions are declared.
      const fns = countFunctions(code, p);
      if (fns < 3) return false;
      if (p.id === "python") {
        const asyncDefs = countAsyncFunctions(code, p);
        // All-async or none-async uniform code is common AI output; a human
        // file usually mixes async and sync functions.
        const oneLiners = matchCount(code, /^[ \t]*def\s+\w+[^\n]*:\s*(?:return|pass)\b[^\n]*$/gm);
        return asyncDefs >= 2 || oneLiners >= fns * 0.6;
      }
      // JS/TS and brace languages: uniform arrow-only style.
      const arrows = matchCount(code, /=>\s*[{(]/g);
      const traditionals = matchCount(code, /\bfunction\s+\w+/g);
      return arrows >= 3 && traditionals === 0;
    },
  },
  {
    family: "structure",
    description: "Every function uses early-return pattern (no if/else variety)",
    weight: 0.55,
    isApplicable: ({ code, p }) => countFunctions(code, p) >= 2,
    test: ({ code, p }) => {
      // A genuine early-return guard is `if (<cond>) return|throw` — the
      // return must be *attached to a guard*, not merely the last statement of
      // a method (which every language has and is not an AI tell).
      if (p.indentBased) {
        const guards = matchCount(
          code,
          /^[ \t]*if\b[^\n]*:\s*\n?[ \t]*(?:return|raise|continue|break)\b/gm
        );
        const elseBlocks = matchCount(code, /^[ \t]*else\s*:/gm);
        return guards >= 2 && elseBlocks === 0;
      }
      const guards = matchCount(
        code,
        /\bif\s*\([^)]*\)\s*(?:\{[^}]*\b(?:return|throw)\b|return\b)/g
      );
      const inlineGuards = matchCount(code, /\bif\b[^\n{]*\b(?:return|throw)\b/g);
      const elseBlocks = matchCount(code, /\belse\s*\{?/g);
      return guards + inlineGuards >= 2 && elseBlocks === 0;
    },
  },
  {
    family: "structure",
    description: "Complex operations compressed into single expressions",
    weight: 0.55,
    isApplicable: ({ code }) => code.includes("."),
    test: ({ code }) => {
      // Chained calls two deep (a.b().c()) appear across most languages.
      const chains = matchCount(code, /\.\w+\([^()]*\)\.\w+\(/g);
      const pipelines = matchCount(
        code,
        /\w+\([^()]*\)\.(?:map|filter|reduce|then|catch|forEach)\(/g
      );
      return chains + pipelines >= 2;
    },
  },
  {
    family: "structure",
    description: "Dense single-line bodies (implicit return everywhere)",
    weight: 0.5,
    isApplicable: ({ code, p }) => countFunctions(code, p) >= 3,
    test: ({ code, p }) => {
      if (p.indentBased) {
        // Python one-line `def f(): return ...` definitions.
        const inline = matchCount(code, /^[ \t]*(?:async\s+)?def\s+\w+[^\n]*:\s*\S/gm);
        return inline >= 3;
      }
      const inlineArrows = matchCount(code, /=\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?!\{)[^;\n]{4,};/g);
      const blockArrows = matchCount(code, /=>\s*[{(]/g);
      return inlineArrows >= 3 && inlineArrows >= blockArrows;
    },
  },

  // --- Comments ---
  {
    family: "comments",
    description: "Comments narrate what the code plainly does",
    weight: 0.9,
    isApplicable: ({ code, p }) =>
      p.lineComment.some((c) => code.includes(c)) || /\/\*|"""|'''/.test(code),
    test: ({ code, p }) => hasNarratingComments(code, p),
  },
  {
    family: "comments",
    description: "Terse documentation block on (nearly) every function",
    weight: 0.75,
    isApplicable: ({ code, p }) => countFunctions(code, p) >= 2,
    test: ({ code, p }) => {
      const functions = countFunctions(code, p);
      const docBlocks = countDocBlocks(code, p);
      if (functions < 2 || docBlocks < Math.ceil(functions / 2)) return false;
      // ...AND the docblocks must be terse (the AI shape). A human codebase
      // like Laravel documents every method, but with substantive multi-line
      // blocks that explain *why*; that must not be flagged.
      return terseDocBlockRatio(code, p) >= 0.6;
    },
  },
  {
    family: "comments",
    description: "High comment density (documentation on everything)",
    weight: 0.6,
    isApplicable: ({ code }) => codeLineCount(code) >= 20,
    test: ({ code, p }) => {
      if (commentRatio(code, p) < 0.2) return false;
      // Well-documented human code (Laravel/PHP, Java, C#) legitimately has a
      // high comment ratio. Only treat it as an AI tell when the documentation
      // is terse and restating — the same guard the docblock signal uses.
      const docBlocks = countDocBlocks(code, p);
      if (docBlocks === 0) return true; // narration lines, not docblocks
      return terseDocBlockRatio(code, p) >= 0.6;
    },
  },

  // --- Error handling ---
  {
    family: "error-handling",
    description: "catch blocks rethrow with a custom message / full logging",
    weight: 0.4,
    isApplicable: ({ code, p }) => countCatchBlocks(code, p) >= 1,
    test: ({ code, p }) => {
      const catchBlocks = countCatchBlocks(code, p);
      if (catchBlocks < 1) return false;
      const richHandlers = matchCount(
        code,
        /catch\s*\([^)]*\)\s*\{[^}]*(?:throw new|logger\.|console\.(?:error|warn)\()|except[^:\n]*:\s*(?:raise|logger\.|logging\.)/g
      );
      return richHandlers >= 1 && richHandlers >= catchBlocks;
    },
  },
  {
    family: "error-handling",
    description: "Every async function wrapped in try/catch",
    weight: 0.45,
    isApplicable: ({ code, p }) => countAsyncFunctions(code, p) >= 2,
    test: ({ code, p }) => {
      const asyncFns = countAsyncFunctions(code, p);
      const tryBlocks = countTryBlocks(code, p);
      return asyncFns >= 2 && tryBlocks >= asyncFns;
    },
  },

  // --- Abstraction ---
  {
    family: "abstraction",
    description: "All repeated logic extracted into helpers immediately",
    weight: 0.5,
    isApplicable: ({ code, p }) => countFunctions(code, p) >= 3,
    test: ({ code, p }) => {
      const todoExtract = /TODO.*extract|TODO.*helper|TODO.*refactor/i.test(code);
      const helpers = matchCount(code, /\b(?:function|const|def|func|fn)\s+\w*[Hh]elper\w*/g);
      const fns = countFunctions(code, p);
      // Many tiny single-purpose helpers packed into a short file. Requiring a
      // high absolute count too avoids flagging small, legitimately-method-heavy
      // classes (a 70-line model with 6 scope methods is not AI slop).
      const dense = fns >= 8 && fns / Math.max(codeLineCount(code) / 15, 1) > 1.5;
      return !todoExtract && (helpers >= 2 || dense);
    },
  },
  {
    family: "abstraction",
    description: "Type/payload declaration for every small shape",
    weight: 0.5,
    isApplicable: ({ code, p, filePath }) =>
      countTypeDeclarations(code, p) > 0 || isTypeScriptPath(filePath),
    test: ({ code, p }) => {
      const types = countTypeDeclarations(code, p);
      if (types === 0) return false;
      const loc = codeLineCount(code);
      // AI defines a named type/payload for roughly every ~60 lines; humans
      // use far fewer named shapes (inline types, `any`, structural literals).
      return loc > 0 && types / loc >= 1 / 60;
    },
  },

  // --- Uniformity ---
  {
    family: "uniformity",
    description: "Naming convention 100% consistent across all scopes",
    weight: 0.5,
    isApplicable: ({ code, p }) => extractDeclarationNames(code, p).length >= 4,
    test: ({ code, p }) => {
      const names = extractDeclarationNames(code, p);
      if (names.length < 4) return false;
      const consistent = names.filter((n) => /^[a-z][a-zA-Z0-9_]*$/.test(n)).length;
      const single = names.filter((n) => n.length === 1).length;
      // No single-letter locals and (almost) fully consistent casing.
      return consistent / names.length >= 0.9 && single <= 1;
    },
  },
  {
    family: "uniformity",
    description: "All functions follow identical structural pattern",
    weight: 0.55,
    isApplicable: ({ code, p }) => countFunctions(code, p) >= 3,
    test: ({ code, p }) => {
      const lines = code.split("\n");
      let bodies = 0;
      let guarded = 0;
      for (let i = 0; i < lines.length; i++) {
        const isFn = isFunctionLine(lines[i], p);
        if (!isFn) continue;
        bodies++;
        const next = (lines[i + 1] ?? "").trim();
        const after = (lines[i + 2] ?? "").trim();
        if (p.negatedGuard.test(next) || p.negatedGuard.test(after)) guarded++;
      }
      return bodies >= 3 && guarded / bodies >= 0.6;
    },
  },

  // --- UI / framework fingerprints ---
  {
    family: "uniformity",
    description: "Uniform JSX/utility-class markup (Tailwind-style classes everywhere)",
    weight: 0.6,
    isApplicable: ({ code }) => /<[A-Za-z][\w.]*[\s/>]/.test(code),
    test: ({ code }) => hasUniformJsxClasses(code),
  },
  {
    family: "structure",
    description: "Exhaustive React hook usage (useCallback/useMemo on everything)",
    weight: 0.6,
    isApplicable: ({ code }) =>
      /\buse(?:State|Effect|Callback|Memo|Reducer|Ref|Context)\b/.test(code),
    test: ({ code }) => hasExhaustiveHooks(code),
  },
  {
    family: "structure",
    description: "Exhaustive static typing on every parameter and return",
    weight: 0.55,
    isApplicable: ({ p }) => p.id === "typescript" || p.id === "python",
    test: ({ code, p }) => hasExhaustiveAnnotations(code, p),
  },
  {
    family: "structure",
    description: "Pervasive lint-driven idioms (void promises, Error ternaries)",
    weight: 0.5,
    isApplicable: ({ p }) => p.id === "typescript" || p.id === "javascript",
    test: ({ code }) => hasModernTsIdiomSoup(code),
  },
];

/** True when a line opens a function body (language-aware). */
function isFunctionLine(line: string, p: LanguageProfile): boolean {
  const re = new RegExp(p.fnDecl.source, p.fnDecl.flags.replace("m", ""));
  return re.test(line);
}

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
  const p = resolveLanguage(filePath, code);
  const ctx: SignalContext = { code, p, filePath };

  const signals: Signal[] = SIGNALS.map((s) => ({
    family: s.family,
    description: s.description,
    weight: s.weight,
    fired: s.isApplicable(ctx) ? s.test(ctx) : false,
  }));

  const firedWeight = signals
    .filter((s) => s.fired)
    .reduce((acc, s) => acc + s.weight, 0);

  if (firedWeight === 0) {
    return { score: 0, signals };
  }

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
