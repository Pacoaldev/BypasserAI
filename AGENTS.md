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
src/git.ts        → reads staged diff via `git show :path`, writes rewritten content back and re-stages
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

Each signal has a `weight` (0–1), a `test(code)` predicate, and an `isApplicable(ctx)` predicate. The final score is `firedWeight / applicableWeight` (normalised only over signals that can fire in the given context), clamped to [0, 1]. Files at or above the effective threshold (per-glob override via `config.thresholds`, else `config.threshold`, default 0.65) are sent for rewriting.

---

## Humanizer skill — how the rewriter uses it

`src/rewriter.ts` loads `docs/SKILL.md` at runtime and injects it as the system prompt. The user message contains the file path and full content. The model returns the rewritten file content only — no markdown fences, no explanations.

When editing `src/rewriter.ts`, the temperature comes from `config.temperature` (default `0.4`) — low enough for consistency, high enough for variation.

---

## Hard rules (correctness over authenticity)

Never degrade security, critical error handling, or legibility to appear more human. A working file that scores slightly higher on an AI detector is better than a broken one that scores lower. The commit is never blocked on tool errors — `audit.ts` catches all rewrite failures and lets the commit proceed.

---

## Scope

This tool targets code authenticity for Git workflows. It is not for defeating plagiarism detectors or academic integrity systems, and names no specific detector. Reframe such requests toward genuine code quality and natural development style (see `docs/SKILL.md` → Limits).
