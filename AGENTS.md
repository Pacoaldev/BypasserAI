# BypasserAI (agent instructions)

This repository is the **bypasser-ai** tool: a Node.js/TypeScript pre-commit hook and CLI that detects AI-generated code patterns in staged git diffs and rewrites them via any OpenAI-compatible API. It also contains the **humanizer** skill (`docs/SKILL.md`) that drives the rewriting.

No scripts beyond the tool itself, no external runtime dependencies beyond Node ≥ 18 and the `openai` SDK. Language-agnostic — works on any project regardless of the code being committed.

It is the entry point for any AI coding tool that reads `AGENTS.md` (Codex, OpenCode, Antigravity, Pi Coder, Kiro, and others).

---

## When to apply the humanizer skill

Apply `docs/SKILL.md` automatically whenever generating, editing, or refactoring code that will end up in a git commit — even when the user does not ask. Do **not** apply it to config files, lock files, build artifacts, or generated content.

---

## Architecture overview

```
src/cli.ts        → command router (init / install / detect / rewrite / audit)
src/config.ts     → loads .bypasser.json and env vars (+ per-glob thresholds, temperature)
src/detector.ts   → deterministic AI-pattern scorer (no API, six signal families)
src/rewriter.ts   → calls OpenAI-compatible API using docs/SKILL.md as system prompt
src/git.ts        → reads staged diff via `git show :path`, writes rewritten content back and re-stages; also `getWorkingTreeFiles()` for `detect --all`
src/installer.ts  → writes/removes the pre-commit hook in .git/hooks/
src/audit.ts      → full pipeline: detect → rewrite → restage
src/logger.ts     → appends .bypasser.log + persists rewrite hashes in .bypasser.state.json
src/notifier.ts   → Windows toast notifications (detached, non-blocking)
src/index.ts      → public library exports
docs/SKILL.md     → humanizer skill prompt loaded at runtime by src/rewriter.ts
test/             → node:test suites (run with tsx)
```

## Commands

```bash
npm run build      # tsc → dist/
npm run typecheck  # tsc over src + test (no emit)
npm test           # tsx --test test/**/*.test.ts
npm run lint       # eslint (flat config)
npm run format     # prettier
```

---

## How to run the tool

```bash
# Initialize config
bypasser init

# Install pre-commit hook
bypasser install

# Manually detect AI patterns in staged files
bypasser detect --verbose

# Score changed files in the working tree, no staging required
bypasser detect --all

# Manually rewrite a file
bypasser rewrite src/utils.ts

# Full audit (detect + rewrite + restage)
bypasser audit --verbose

# Dry run — detect only, no API calls
bypasser audit --dry-run
```

---

## Configuration

The tool reads `.bypasser.json` at the project root. All fields are optional:

```json
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o",
  "threshold": 0.65,
  "maxTokens": 4096,
  "ignore": []
}
```

Environment variables override file config: `BYPASSER_API_KEY`, `BYPASSER_BASE_URL`, `BYPASSER_MODEL`. `OPENAI_API_KEY` is used as fallback.

Any OpenAI-compatible endpoint works: OpenAI, Ollama, LM Studio, OpenRouter, Groq, Anthropic via proxy.

---

## Detector signal families

When working on `src/detector.ts`, these are the six families and their intent:

| Family | What it detects |
|--------|----------------|
| `naming` | Over-descriptive names, zero pragmatic short vars (`aux`, `tmp`, `idx`) |
| `structure` | Uniform arrow-only syntax, identical patterns across all functions |
| `comments` | Narration comments, JSDoc on every function |
| `error-handling` | Exhaustive catch on every function, every async wrapped in try/catch |
| `abstraction` | Immediate extraction of all repeated code, interface for every small type |
| `uniformity` | Zero single-letter vars, every function block structurally identical |

Each signal has a `weight` (0–1), a `test(code)` predicate, and an `isApplicable(ctx)` predicate. The final score maps the **fired** weight through a saturating curve `1 - e^(-w / 2.5)`, clamped to [0, 1]. A score of exactly 0 is returned **only** when no signal fires at all.

> Why not `firedWeight / applicableWeight`? AI code fires a *correlated cluster* of signals, not all of them, so a plain ratio caps around 0.45 — below any usable threshold, which meant nothing ever got rewritten. The saturating curve puts realistic AI code at 70–85% and clean code under ~35%. Do not "fix" it back to a ratio.

> **Never hard-zero a non-zero fired weight.** An earlier `MIN_FIRED_WEIGHT = 0.6` gate forced the score to a literal 0 whenever the fired weight was below 0.6. That meant a real AI file tripping a single weak signal reported `0% — no AI signals`, which reads as "confirmed human" — the worst possible output. The saturating curve already keeps a lone weak signal near ~0.15 (well below threshold); let it do that instead of forcing 0.

### Calibration (do not regress)

Every `test`/`isApplicable` predicate must be written against **idiomatic real-world code**, not toy snippets. The original predicates only matched `const x = () =>` and missed `export async function`, tried to match function bodies with `[^}]` (breaks on nesting), and required ≥2 occurrences of things that appear once in real files — the result was that **8 of 13 signals never fired on any real AI file**. Use the line-based helpers (`countFunctions`, `countCatchBlocks`, `countJsDocBlocks`, `hasNarratingComments`, …) rather than fragile multi-line regexes. `test/detector.test.ts` locks this with fixtures shaped like real repo files (`REAL_IDIOMATIC_AI`, `REALISTIC_AI_TS`) plus a hand-written human counter-example that must stay below threshold.

Files at or above the effective threshold (per-glob override via `config.thresholds`, else `config.threshold`, default 0.65) are sent for rewriting.

---

## Humanizer skill — how the rewriter uses it

`src/rewriter.ts` loads `docs/SKILL.md` at runtime and injects it as the system prompt. The user message contains the file path and full content. The model returns the rewritten file content only — no markdown fences, no explanations.

When editing `src/rewriter.ts`, the temperature comes from `config.temperature` (default `0.4`) — low enough for consistency, high enough for variation.

### Truncation guard (never remove)

A rewrite must **never** silently lose part of a file. This is a hard invariant: a model cut off at `max_tokens` produced a valid-looking response that passed the old sanitizer and was restaged over the original, destroying ~2000 lines of a file. `sanitizeResponse` therefore rejects a response when **any** of these hold, always keeping the original:

1. `finish_reason === "length"` — the model ran out of tokens (the only 100% reliable signal).
2. `looksTruncated()` — the result is under 75% of the original line count (for files ≥12 lines) or has unbalanced brackets outside strings/comments.
3. Chatbot prose or no recognisable code token (the original prose guard).

And the write itself is defensive: `restageFile()` (in `git.ts`) refuses to write empty content over a non-empty file, copies the current content to `<path>.bak`, and writes atomically (temp + rename). Do not weaken or bypass any of these — `test/rewriter.test.ts` and `test/restage.test.ts` lock them in.

---

## Hard rules (correctness over authenticity)

Never degrade security, critical error handling, or legibility to appear more human. A working file that scores slightly higher on an AI detector is better than a broken one that scores lower. The commit is never blocked on tool errors — `audit.ts` catches all rewrite failures and lets the commit proceed.

---

## Scope

This tool targets code authenticity for Git workflows. It is not for defeating plagiarism detectors or academic integrity systems, and names no specific detector. Reframe such requests toward genuine code quality and natural development style (see `docs/SKILL.md` → Limits).
