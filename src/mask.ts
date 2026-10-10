/**
 * String / comment masking for the detector.
 *
 * ## Why this module exists
 *
 * Every detector signal is a regex over the raw source text. That is cheap and
 * dependency-free, but it means the detector cannot tell *code* from *text that
 * looks like code*. Three concrete false-positive/false-negative classes came
 * out of that:
 *
 *   1. A comment marker inside a string — `const s = "// Validate input"` — was
 *      counted as a narrating comment and pushed a clean file toward the
 *      threshold.
 *   2. A `#` inside a JS/Ruby/Go string, or a `//` inside a URL literal
 *      (`"https://api…"`), was treated as a comment.
 *   3. Regex-looking text inside a string or comment — `url.match(/function\s+/g)`
 *      — was counted as a real function declaration, inflating the function
 *      count and flipping structural signals.
 *
 * The fix is to run each signal over a **masked** view of the source instead of
 * the raw text:
 *
 *   - `code`       — strings *and* comments blanked to spaces. Structural /
 *                    naming / abstraction signals use this so neither a comment
 *                    nor a string literal can fake code.
 *   - `comments`   — only the text *inside* comments, everything else blanked.
 *                    Comment-family signals use this so `"// …"` inside a
 *                    string is never a comment.
 *   - `documented` — strings blanked, comments kept verbatim (markers included).
 *                    Docblock signals use this: their regexes match the
 *                    `/** … *\/` / `""" … """` *delimiters*, which must survive,
 *                    while a string that merely looks like a docblock is still
 *                    neutralised.
 *
 * This mirrors what `bracket-balance.ts` already does for bracket counting and
 * reuses the same `LanguageProfile` (which knows each language's `lineComment`
 * prefixes and whether it has triple-quoted strings).
 *
 * The masker is deliberately approximate — a regex-grade scanner, not a parser.
 * Its only contract is: **never let string/comment text leak into the code
 * view, never let code leak into the comment view**, for the token classes the
 * detector looks at.
 */
import type { LanguageProfile } from "./detector.js";

/** The masked views the detector scores against. */
export interface MaskedSource {
  /**
   * Source with every string literal AND comment body replaced by spaces
   * (newlines preserved, so line-based regexes still see the same line
   * structure). Used by structural / naming / abstraction signals: a comment
   * that mentions `function` must not inflate the function count, and a string
   * containing `//` must not read as a comment.
   */
  code: string;
  /**
   * Only the *text content* of comments, with all code replaced by spaces.
   * Used by the comment-family signals so a comment marker inside a string is
   * never mistaken for a comment.
   */
  comments: string;
  /**
   * Source with strings blanked but comments left intact (markers included).
   * Used by the docblock signals: their regexes match the `/** … *\/` /
   * `""" … """` *delimiters*, which must survive, while strings that merely
   * look like docblocks are still neutralised.
   */
  documented: string;
}

function supportsTripleQuotes(p: LanguageProfile): boolean {
  return p.id === "python" || p.id === "ruby";
}

function supportsBlockComments(p: LanguageProfile): boolean {
  return p.lineComment.includes("//") || p.id === "php";
}

/** Languages whose string literals may carry a `f`/`r`/`b`/`u` prefix. */
function supportsStringPrefixes(p: LanguageProfile): boolean {
  return p.id === "python";
}

/** Languages with `r#"…"#` / `r"…"` raw strings. */
function supportsRawStrings(p: LanguageProfile): boolean {
  return p.id === "rust";
}

/**
 * Languages with JS-style `/…/flags` regex literals.
 *
 * Exported so `bracket-balance.ts` can share the exact same notion of "this
 * language has regex literals" — the balance scanner must ignore brackets
 * inside `/…/` for the same reason the masker must blank them. Two scanners
 * disagreeing on that is how a valid TS file with `/\{\s*$/` got reported as
 * "unbalanced" and its rewrite rejected.
 */
export function supportsRegexLiterals(p: LanguageProfile): boolean {
  return p.id === "javascript" || p.id === "typescript";
}

/**
 * Decide whether a `/` at `i` starts a regex literal (rather than a division).
 *
 * Heuristic: a regex can only follow something that is *not* an expression end.
 * So if the last significant character is an identifier char, a digit, or a
 * closing `)`, `]`, `}`, the `/` is division; otherwise it opens a regex. This
 * is the standard lexer heuristic and is correct for the cases the detector
 * cares about (strings/comments in real code), not a full JS lexer.
 *
 * Exported for `bracket-balance.ts` — see `supportsRegexLiterals`.
 */
export function looksLikeRegexStart(source: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(source[k])) k--;
  if (k < 0) return true; // start of file — a regex
  const prev = source[k];
  if (/[A-Za-z0-9_$]/.test(prev)) {
    // A keyword like `return` / `typeof` / `case` ends in a letter but is
    // followed by a *regex*, not a division (`return /re/.test(x)`). Without
    // this, `/…/` after a keyword was misread as division and its brackets
    // leaked into the balance scanner — the `return /^(?:\(empresa…$/i` case.
    let ws = k;
    while (ws >= 0 && /[A-Za-z0-9_$]/.test(source[ws])) ws--;
    const word = source.slice(ws + 1, k + 1);
    if (REGEX_PRECEDING_KEYWORDS.has(word)) return true;
    return false; // identifier/number → division
  }
  if (prev === ")" || prev === "]" || prev === "}") return false; // expr end → division
  return true;
}

/**
 * Keywords after which a `/` starts a regex literal (`return /…/`, `typeof /…/`,
 * `case /…/:`). A letter ends these words, so the identifier heuristic alone
 * would call the `/` a division.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "delete",
  "void",
  "yield",
  "await",
  "new",
  "do",
  "else",
]);

/**
 * Consume a `/…/flags` regex literal starting at `i`; return its end index.
 *
 * Exported alongside `looksLikeRegexStart` so `bracket-balance.ts` can skip
 * bracket characters inside a regex body (`/\{\s*$/` must not count as an
 * unbalanced `{`).
 */
export function regexLiteralEnd(source: string, i: number): number {
  const n = source.length;
  let j = i + 1;
  let inClass = false; // inside a `[...]` character class, `/` does not close
  while (j < n) {
    const c = source[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return j; // unterminated — do not swallow the file
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      // Flags: consecutive identifier chars.
      while (j < n && /[a-z]/i.test(source[j])) j++;
      return j;
    }
    j++;
  }
  return j;
}

/** True when `code[i]` begins a triple-quote delimiter at `i`. */
function tripleQuoteAt(code: string, i: number): '"' | "'" | null {
  const ch = code[i];
  if (ch !== '"' && ch !== "'") return null;
  if (code[i + 1] === ch && code[i + 2] === ch) return ch;
  return null;
}

/**
 * Produce the three masked views for `source` under `profile`.
 *
 * The scanner walks the source once, tracking whether it is inside a string
 * (single, double, backtick, or triple-quoted), a line comment, or a block
 * comment, and writes into three parallel buffers. Character positions are
 * preserved so line numbers and column offsets in every view match the
 * original — important because several signals are line-anchored (`^` with the
 * `m` flag).
 */
export function maskSource(source: string, profile: LanguageProfile): MaskedSource {
  const n = source.length;
  const codeBuf: string[] = new Array(n);
  const commentBuf: string[] = new Array(n);
  const docBuf: string[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const ch = source[k];
    codeBuf[k] = ch;
    commentBuf[k] = ch === "\n" ? "\n" : " ";
    docBuf[k] = ch;
  }

  // Blank a `[from, to)` span in `buf`, preserving newlines.
  const blank = (buf: string[], from: number, to: number): void => {
    for (let k = from; k < to; k++) if (buf[k] !== "\n") buf[k] = " ";
  };

  const lineComments = profile.lineComment;
  const triple = supportsTripleQuotes(profile);
  const blockComments = supportsBlockComments(profile);
  const stringPrefixes = supportsStringPrefixes(profile);
  const rawStrings = supportsRawStrings(profile);
  const regexLiterals = supportsRegexLiterals(profile);

  const lineCommentLenAt = (idx: number): number => {
    for (const prefix of lineComments) {
      if (prefix.length > 0 && source.startsWith(prefix, idx)) return prefix.length;
    }
    return 0;
  };

  /**
   * Record a comment span `[from, to)`:
   *   - blank it in the code view (`code`),
   *   - copy its inner text (past the `strip` marker chars) into the comments view,
   *   - keep it verbatim in the documented view (`doc`).
   */
  const emitComment = (from: number, to: number, strip: number): void => {
    blank(codeBuf, from, to);
    for (let k = from; k < to; k++) if (source[k] === "\n") commentBuf[k] = "\n";
    for (let k = from + strip; k < to; k++) if (source[k] !== "\n") commentBuf[k] = source[k];
  };

  /** Blank a string span `[from, to)` in the code AND documented views. */
  const emitString = (from: number, to: number): void => {
    blank(codeBuf, from, to);
    blank(docBuf, from, to);
  };

  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // --- Line comment ---
    const lc = lineCommentLenAt(i);
    if (lc > 0) {
      let end = source.indexOf("\n", i);
      if (end === -1) end = n;
      emitComment(i, end, lc);
      i = end;
      continue;
    }

    // --- Block comment (`/* … */`) ---
    if (blockComments && ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      // Strip the `/*` and `*/` markers from the comments-view text only.
      blank(codeBuf, i, end);
      for (let k = i; k < end; k++) if (source[k] === "\n") commentBuf[k] = "\n";
      const innerFrom = i + 2;
      const innerTo = close === -1 ? end : close;
      for (let k = innerFrom; k < innerTo; k++) {
        if (source[k] !== "\n") commentBuf[k] = source[k];
      }
      i = end;
      continue;
    }

    // --- Triple-quoted string (Python / Ruby docstrings & multi-line strings) ---
    if (triple) {
      const tq = tripleQuoteAt(source, i);
      if (tq !== null) {
        const delim = tq.repeat(3);
        const close = source.indexOf(delim, i + 3);
        const end = close === -1 ? n : close + 3;
        // A Python docstring is a *string*, not a language comment. The
        // detector's docblock signal nevertheless treats `"""…"""` as
        // documentation, so we KEEP it in the `documented` view (delimiters and
        // all) and blank it only in the `code` view — so prose inside it never
        // scans as code, yet `countDocBlocks` / `terseDocBlockRatio` still see
        // the docstring (this is what the `docBlock` profile regex matches).
        blank(codeBuf, i, end);
        i = end;
        continue;
      }
    }

    // --- Python string prefixes: f"…", r"…", rb'…', u"…" -----------------
    // The quote itself is handled by the plain-string branch below; we detect
    // the prefix here only when a triple-quoted form follows (`f"""…"""`),
    // which the triple-quote branch would otherwise miss because it is entered
    // at the quote, after the prefix letter.
    if (stringPrefixes && /[a-zA-Z]/.test(ch)) {
      const rest = source.slice(i);
      const pm = rest.match(/^([rRbBuUfF]{1,2})("""|'''|"|')/);
      if (pm) {
        const quoteStart = i + pm[1].length;
        const delim = pm[2];
        if (delim.length === 3) {
          const close = source.indexOf(delim, quoteStart + 3);
          const end = close === -1 ? n : close + 3;
          blank(codeBuf, i, end);
          i = end;
          continue;
        }
        // single/double: fall through to the plain-string scanner from the
        // quote position, and blank the prefix too.
        let j = quoteStart + 1;
        while (j < n) {
          if (source[j] === "\\") {
            j += 2;
            continue;
          }
          if (source[j] === delim) break;
          if (source[j] === "\n") break;
          j++;
        }
        const end = j < n && source[j] === delim ? j + 1 : j;
        blank(codeBuf, i, end);
        blank(docBuf, i, end);
        i = end;
        continue;
      }
    }

    // --- Rust raw strings: r"…" and r#"…"# (any number of #) --------------
    if (rawStrings && ch === "r" && (next === '"' || next === "#")) {
      const m = source.slice(i).match(/^r(#*)"/);
      if (m) {
        const hashes = m[1];
        const closer = '"' + hashes;
        const bodyStart = i + m[0].length;
        const close = source.indexOf(closer, bodyStart);
        const end = close === -1 ? n : close + closer.length;
        blank(codeBuf, i, end);
        blank(docBuf, i, end);
        i = end;
        continue;
      }
    }

    // --- JS/TS regex literal: /…/flags (never a division) ----------------
    if (regexLiterals && ch === "/" && next !== "/" && next !== "*") {
      if (looksLikeRegexStart(source, i)) {
        const end = regexLiteralEnd(source, i);
        blank(codeBuf, i, end);
        i = end;
        continue;
      }
    }

    // --- Single/double/backtick string ---
    if (ch === '"' || ch === "'" || ch === "`") {
      const delim = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === delim) break;
        // A single-quoted string does not span a raw newline in most languages;
        // bail out so an unterminated quote does not swallow the whole file.
        if (source[j] === "\n" && delim !== "`") break;
        j++;
      }
      const end = j < n && source[j] === delim ? j + 1 : j;
      emitString(i, end);
      i = end;
      continue;
    }

    i++;
  }

  return {
    code: codeBuf.join(""),
    comments: commentBuf.join(""),
    documented: docBuf.join(""),
  };
}
