/**
 * Language-aware bracket balance scanner.
 *
 * ## Why this module exists
 *
 * The original balance check lived inside `rewriter.ts` and only understood
 * C-style surface syntax: it knew `//` line comments, `/* … *\/` (never
 * actually handled), and `'…'` / `"…"` / `` `…` `` strings. On Python (and
 * Ruby, shell, YAML, PHP) that is wrong in two ways that produced **false
 * "unbalanced brackets" rejections on perfectly valid files**:
 *
 *   1. It did **not** treat `#` as a comment. A Python comment like
 *      `# concurrent .get()/.post() across threads` therefore leaked two `(`
 *      and one `)` into the bracket stack — and any comment with an unpaired
 *      bracket made the whole file look "cut off". Real files routinely carry
 *      such comments, so the humanizer's output (which keeps comments) was
 *      rejected every time and the *original* slop was committed — the exact
 *      "it always uploads the original" failure this tool exists to prevent.
 *   2. It did **not** understand Python triple-quoted strings / docstrings
 *      (`"""…"""`, `'''…'''`). Text inside them (prose, code samples, brackets)
 *      was scanned as if it were code.
 *
 * The fix is to drive the scanner from the same `LanguageProfile` the detector
 * already resolves (which knows each language's `lineComment` prefixes), and to
 * teach it the multi-char string delimiters a line-based check must skip:
 * Python/Ruby triple quotes, backticks, and C-style `/* … *\/` block comments.
 *
 * The scanner is still deliberately *approximate* — it is a cheap structural
 * tell, not a parser. Its only contract is: **never report a valid file as
 * unbalanced because of text inside a comment or string.** A real parser
 * (`syntax-guard.ts`) remains the definitive backstop for assembly.
 */
import type { LanguageProfile } from "./detector.js";

/** Bracket pairs the scanner tracks. */
const CLOSING: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
const OPENING = new Set(["{", "(", "["]);

/** Languages whose string literals may be delimited by `"""` / `'''`. */
function supportsTripleQuotes(p: LanguageProfile): boolean {
  return p.id === "python" || p.id === "ruby";
}

/** Languages / profiles that use C-style `/* … *\/` block comments. */
function supportsBlockComments(p: LanguageProfile): boolean {
  // `//`-family languages plus PHP (which also has `//`).
  return p.lineComment.includes("//") || p.id === "php";
}

/** True when `code[i]` begins a triple-quote delimiter at `i`. */
function tripleQuoteAt(code: string, i: number): '"' | "'" | null {
  const ch = code[i];
  if (ch !== '"' && ch !== "'") return null;
  if (code[i + 1] === ch && code[i + 2] === ch) return ch;
  return null;
}

/**
 * Rough bracket-balance check, aware of the language's comments and string
 * delimiters. Brackets inside strings/comments are ignored, so a comment or
 * docstring containing an unpaired bracket never trips it.
 *
 * Returns `true` when brackets are unbalanced *outside* strings/comments —
 * i.e. the code was most likely cut off mid-block.
 */
export function hasUnbalancedBrackets(
  code: string,
  profile?: LanguageProfile
): boolean {
  const stack: string[] = [];

  // Comment prefixes for this language (`//`, `#`, …). Falls back to C-style so
  // a missing profile never silently disables comment detection.
  const lineComments = profile?.lineComment ?? ["//"];
  const triple = profile ? supportsTripleQuotes(profile) : false;
  const blockComments = profile ? supportsBlockComments(profile) : true;

  // Python-style f-strings: inside `f"…{expr}…"` the `{…}` is *code*, not text,
  // and it is balanced. We do not model it specially — we simply treat the
  // whole string as string content (the `{`/`}` inside are ignored), which is
  // correct for balance purposes because a well-formed f-string's placeholders
  // are themselves balanced.

  let i = 0;
  const n = code.length;
  let inLineComment = false;
  let inBlockComment = false;
  // Current string delimiter: a single char (`"` / `'`) or a triple quote
  // (`"""` / `'''`), or null when not inside a string.
  let stringDelim: string | null = null;
  /** True while inside a JS/TS template literal (backtick). */
  let inBacktick = false;

  const isLineCommentStart = (idx: number): number => {
    // Returns the length of the matching line-comment prefix at idx, or 0.
    for (const prefix of lineComments) {
      if (prefix.length > 0 && code.startsWith(prefix, idx)) return prefix.length;
    }
    return 0;
  };

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (stringDelim) {
      // Inside a string: handle escapes, then look for the closing delimiter.
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (stringDelim.length === 3) {
        if (ch === stringDelim[0] && next === stringDelim[0] && code[i + 2] === stringDelim[0]) {
          stringDelim = null;
          i += 3;
          continue;
        }
        i++;
        continue;
      }
      if (ch === stringDelim) {
        stringDelim = null;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (inBacktick) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        inBacktick = false;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // --- Not inside a string or comment: recognise openers. ---

    // Line comment?
    const lc = isLineCommentStart(i);
    if (lc > 0) {
      inLineComment = true;
      i += lc;
      continue;
    }

    // Block comment (`/* … *\/`) — only for languages that have it.
    if (blockComments && ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    // Triple-quoted string (Python/Ruby docstrings and multi-line strings).
    if (triple) {
      const tq = tripleQuoteAt(code, i);
      if (tq !== null) {
        stringDelim = tq.repeat(3);
        i += 3;
        continue;
      }
    }

    // A single/double quote opens a string. Python string prefixes (`r"…"`,
    // `f"…"`, `rb'…'`) are letters immediately before the quote; we treat the
    // quote itself as the opener and the prefix letter is simply scanned as an
    // ordinary character (never a bracket), so no special handling is needed.
    if (ch === '"' || ch === "'") {
      stringDelim = ch;
      i++;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      i++;
      continue;
    }

    if (OPENING.has(ch)) {
      stack.push(ch);
    } else if (ch in CLOSING) {
      if (stack.length === 0 || stack[stack.length - 1] !== CLOSING[ch]) {
        // A closer with no matching opener — structurally broken.
        return true;
      }
      stack.pop();
    }
    i++;
  }

  // Anything left open means the file was cut off mid-block.
  return stack.length > 0;
}
