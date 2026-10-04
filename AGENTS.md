# BypasserAI (agent instructions)

This repository is the **bypasser-ai** tool: a Node.js/TypeScript pre-commit hook and CLI that scores **full staged file content** for AI-generated patterns (git diffs gate eligibility and choose rewrite scope) and rewrites flagged files via any OpenAI-compatible API. It also contains the **humanizer** skill (`docs/SKILL.md`) that drives the rewriting.

No scripts beyond the tool itself, no external runtime dependencies beyond Node ≥ 18 and the `openai` SDK. Language-agnostic — works on any project regardless of the code being committed.

It is the entry point for any AI coding tool that reads `AGENTS.md` (Codex, OpenCode, Antigravity, Pi Coder, Kiro, and others).

---

## When to apply the humanizer skill

Apply `docs/SKILL.md` automatically whenever generating, editing, or refactoring code that will end up in a git commit — even when the user does not ask. Do **not** apply it to config files, lock files, build artifacts, or generated content.

---

## Architecture overview

```
src/cli.ts               → command router (init / install / uninstall / detect / rewrite / audit)
src/config.ts            → loads .bypasser.json and env vars (+ per-glob thresholds, scope, timeouts)
src/detector.ts          → deterministic AI-pattern scorer (no API, six signal families). Language-agnostic via per-language profiles (JS, TS, Python, Go, Rust, Java, C#, C/C++, Ruby, PHP, unknown).
src/rewriter.ts          → calls OpenAI-compatible API using docs/SKILL.md as system prompt; full-file / diff-hunk / chunk strategies + response sanitizer
src/rewrite-constants.ts → shared truncation/compression ratios (used by rewriter + restageFile)
src/rewrite-validate.ts  → post-rewrite validators: looksIndentBroken, looksStructurallyBroken
src/bracket-balance.ts   → language-aware bracket balance scanner (respects `#` comments, Python docstrings, block comments); the `unbalanced-brackets` truncation signal
src/syntax-guard.ts      → best-effort parse check (Python via interpreter, JSON via JSON.parse) on assembled/full rewrites
src/diff-hunks.ts        → parse/merge unified-diff hunk ranges, slice/splice, addedLineFraction
src/chunk-split.ts       → splits a file into chunks at top-level declaration boundaries (per language)
src/concurrency.ts       → mapPool: bounded-concurrency async pool, order-preserving
src/git.ts               → one `git diff --cached` per audit (`splitCachedDiffByPath`), staged blob via `git show :path`, restage + `getWorkingTreeFiles()` for `detect --all`
src/installer.ts         → writes/removes the pre-commit hook; `HOOK_INSTALL_EXCLUDED_REPO_NAMES` (opt-out list, `BYPASSER_HOOK_EXCLUDED_REPOS`)
src/audit.ts             → full pipeline: detect → rewrite → restage → log → notify
src/logger.ts            → appends .bypasser.log + persists rewrite hashes and detection cache in .bypasser.state.json
src/notifier.ts          → Windows toast notifications (BurntToast → WinRT → balloon, detached)
src/index.ts             → public library exports
docs/SKILL.md            → humanizer skill prompt loaded at runtime by src/rewriter.ts
scripts/canonical-bypasser.json → full default knobs for bulk `.bypasser.json` sync (skip excluded repos)
scripts/test.js          → cross-platform test runner (resolves test files, requires Node >= 20.6 for tsx --import)
test/                    → node:test suites (run via scripts/test.js)
```

`src/index.ts` exports the public library surface (detector, rewriter, audit, config, git, install helpers including `isHookInstallExcluded`).

## Commands

```bash
npm run build      # tsc → dist/
npm run typecheck  # tsc over src + test (no emit)
npm test           # node scripts/test.js  → node --import tsx --test on resolved test files
npm run dev        # tsc --watch
npm run lint       # eslint (flat config)
npm run format     # prettier
```

> Tests run on Node >= 20.6 (tsx v4 needs `--import`). The shipped CLI in `dist/` still supports Node >= 18. `scripts/test.js` exists because Node's `--test` only accepts explicit file paths on CI (globs fail).

### ⚠️ After changing `src/`, run `npm run build` — or the hook runs stale code

`dist/` is **gitignored** (not versioned); the CLI a project actually executes is `dist/cli.js`. When the CLI is linked globally (`npm link`, or a junction on Windows pointing `npm/node_modules/bypasser-ai` → this repo), **every project that invokes `bypasser` runs this repo's local `dist/`**. Consequences:

- Editing `src/*.ts` does **nothing** for any project until `npm run build` regenerates `dist/`. A stale `dist/` means the hook runs old logic everywhere.
- `git clone` + point the junction/hook at the repo **without** building ⇒ stale `dist/` (the classic "I fixed it but it still breaks" trap).
- Shipping via the published tarball is fine: `package.json` → `files: ["dist", …]` bundles the built output.
- CI (`.github/workflows/ci.yml`) runs `npm run build` after lint/typecheck/test, so a build that would fail is caught pre-merge.

**Rule of thumb:** change `src/` → `npm run build` → (optionally) `npm test`. Never hand-edit `dist/`.

---

## How to run the tool

```bash
# Initialize config (no-op if .bypasser.json already exists)
bypasser init

# Regenerate .bypasser.json with the defaults, overwriting the existing one
bypasser init --force

# Install pre-commit hook
bypasser install

# Remove the pre-commit hook
bypasser uninstall
```

### Hook install exclusions (opt-out mechanism)

Some repositories ship their **own** pre-commit workflow and must **never** receive `bypasser install`, bulk hook rollout, or `.bypasser.json` sync — bypasser would conflict with or overwrite their hook.

This is a generic opt-out, not tied to any specific repo. List the folder names (lowercased, comma-separated) in the `BYPASSER_HOOK_EXCLUDED_REPOS` environment variable — e.g. `BYPASSER_HOOK_EXCLUDED_REPOS="my-repo,other-repo"`. For a fixed monorepo roster, add names to the default set in `src/installer.ts`.

Enforced in code: `HOOK_INSTALL_EXCLUDED_REPO_NAMES` in `src/installer.ts` (`isHookInstallExcluded()`). `bypasser install` inside an excluded repo throws; `bypasser uninstall` still works if our hook was installed by mistake. Agents running mass `bypasser install` under `PROYECTOS` must **skip** those directories.

```bash
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

# What the pre-commit hook runs (compact summary; use BYPASSER_VERBOSE=1 for detail)
bypasser audit --pre-commit
```

The installed hook invokes `audit --pre-commit` **without** `--verbose`. Audit failures and safety rejections **never block** the commit (`process.exit(0)`); check `.bypasser.log` and the hook summary line for `rejected` / API errors.

`detect` uses the same **full-file** scoring as audit (not diff-only), so scores match what the hook would see after staging.

---

## Configuration

The tool reads `.bypasser.json` at the project root. All fields are optional; missing keys are filled from `DEFAULTS` in `src/config.ts` at runtime.

**Effective defaults** (also in `scripts/canonical-bypasser.json` for bulk sync — copy into host projects, **never** into a repo listed in `BYPASSER_HOOK_EXCLUDED_REPOS`):


```json
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "threshold": 0.65,
  "maxTokens": 16384,
  "temperature": 0.4,
  "ignore": [],
  "thresholds": [],
  "timeoutMs": 120000,
  "timeoutPer1kLinesMs": 30000,
  "maxTimeoutMs": 600000,
  "maxFileLines": 2000,
  "rewriteConcurrency": 3,
  "rewriteScope": "auto",
  "rewriteFullFileBelowLines": 400,
  "contextLines": 60,
  "maxChunkLines": 450,
  "structuralCheck": true
}
```

Key fields (see `src/config.ts` `BypasserConfig` for the source of truth):

- `threshold` (0–1, default 0.65) — score above which a file is rewritten.
- `thresholds` — per-glob overrides `[{ "pattern": "src/legacy/**", "value": 0.3 }]`; first match wins (`resolveThreshold`).
- `temperature` (default 0.4) — rewrite sampling temperature.
- `timeoutMs` / `timeoutPer1kLinesMs` / `maxTimeoutMs` — base rewrite timeout (2 min), +30 s per extra 1000 lines, hard cap 10 min (`scaledTimeoutMs`).
- `maxFileLines` (default 2000, `0` disables) — skip full-file rewrites above this size; `diff`/`chunk` scopes still run.
- `rewriteConcurrency` (default 3) — parallel rewrite API calls per audit (`mapPool`).
- `rewriteScope` (`file` | `diff` | `chunk` | `auto`, default `auto`) — how content is sent to the model.
- `rewriteFullFileBelowLines` / `contextLines` / `maxChunkLines` — knobs for the `auto` scope decision and diff/chunk slicing.
- `structuralCheck` (default true) — reject rewrites that drop too many top-level declarations.

Environment variables override file config: `BYPASSER_API_KEY`, `BYPASSER_BASE_URL`, `BYPASSER_MODEL`. `OPENAI_API_KEY` is used as fallback. `BYPASSER_VERBOSE=1` forces verbose output for `audit`.

`bypasser init` only writes `.bypasser.json` when it does not already exist (guarded by `existsSync`), so it can never clobber an `apiKey` or hand-tuned settings. `bypasser init --force` bypasses the guard and regenerates a **starter** file from `src/cli.ts` (core rewrite knobs; timeout/`maxFileLines` fields may be omitted — runtime still uses `DEFAULTS`). For a complete on-disk template, use `scripts/canonical-bypasser.json`. `init` also appends `.bypasser.log`, `.bypasser.state.json`, `*.bypasser.tmp`, and `*.bak` to `.gitignore`.

Default model **`gpt-4o-mini`** is the shipped baseline; for large files/chunks prefer a model that returns the fragment at full length and re-validate truncation on your endpoint.

Built-in ignore globs (`BUILT_IN_IGNORE` in `config.ts`) always skip lockfiles, `dist/**`, minified assets, most `*.json`/`*.yaml`, and bypasser artifacts (`*.bak`, `*.bypasser.tmp`).

Any OpenAI-compatible endpoint works: OpenAI, Ollama, LM Studio, OpenRouter, Groq, Anthropic via proxy.

---

## Detector signal families

When working on `src/detector.ts`, these are the six families and their intent:

| Family | What it detects |
|--------|----------------|
| `naming` | Over-descriptive names, zero pragmatic short vars (`aux`, `tmp`, `idx`) |
| `structure` | Uniform function-declaration style, early-return guards everywhere, long chains, exhaustive type annotations, lint-driven idioms |
| `comments` | Short imperative narration comments, terse docblocks on every function |
| `error-handling` | Exhaustive catch on every function, every async wrapped in try/catch |
| `abstraction` | Immediate extraction of all repeated code, a named payload type for every small shape |
| `uniformity` | Zero single-letter vars, every function block structurally identical, uniform JSX/Tailwind markup, exhaustive React hooks |

Each signal has a `weight` (0–1), a `test(ctx)` predicate, and an `isApplicable(ctx)` predicate. The final score maps the **fired** weight through a saturating curve `1 - e^(-w / 2.5)`, clamped to [0, 1]. A score of exactly 0 is returned **only** when no signal fires at all.

> Why not `firedWeight / applicableWeight`? AI code fires a *correlated cluster* of signals, not all of them, so a plain ratio caps around 0.45 — below any usable threshold, which meant nothing ever got rewritten. The saturating curve puts realistic AI code at 70–85% and clean code under ~50%. Do not "fix" it back to a ratio.

> **Never hard-zero a non-zero fired weight.** An earlier `MIN_FIRED_WEIGHT = 0.6` gate forced the score to a literal 0 whenever the fired weight was below 0.6. That meant a real AI file tripping a single weak signal reported `0% — no AI signals`, which reads as "confirmed human" — the worst possible output. The saturating curve already keeps a lone weak signal near ~0.15 (well below threshold); let it do that instead of forcing 0.

### Language-agnostic calibration (do not regress)

The detector must recognise idiomatic AI code in **every** language, not just JavaScript. Original helpers only matched `function`/`const x =`/`=>`/`/** */`, so on Python a real AI file tripped **zero** signals and scored 0% — the exact "Cursor says 100% AI, bypasser says 0%" failure. The fix is a `LanguageProfile` layer: `resolveLanguage(filePath, code)` maps an extension (or sniffs the source) to a profile that knows how the language spells function declarations, doc comments, variable declarations, guards, etc. **A signal must never hard-code a single language's syntax — always read from the resolved profile.**

Rules for tuning `test`/`isApplicable`:

- Write predicates against **idiomatic real-world code**, not toy snippets. `test/detector.test.ts` locks this with fixtures shaped like real repo files (`REAL_IDIOMATIC_AI`, `REALISTIC_AI_TS`, `REALISTIC_AI_PYTHON`, `HUMAN_DOCUMENTED_PHP`).
- Keep the **human counter-examples below threshold**: `HUMAN_DOCUMENTED_PHP` (a Laravel model with substantive docblocks) and the hand-written terse-code fixtures must stay under 0.65. A well-documented human codebase is *not* AI slop.
- Docblocks are only an AI tell when they are **terse** (≤2 content lines, no `@param`/`Args:` annotations). Informative multi-line docblocks — the norm in Laravel, JSDoc-heavy TS, and NumPy-docstring Python — must not be flagged. See `terseDocBlockRatio`.
- Do not count a class-based file's **primary class** as a "payload type" (`countTypeDeclarations` subtracts the main class); otherwise every short human class looks like an AI payload shape.
- A `catch`/`recover` handler or a single `void promise` is legitimate on its own; these are deliberately weak or cluster-gated so they never flag healthy human code alone.

Files at or above the effective threshold (per-glob override via `config.thresholds`, else `config.threshold`, default 0.65) are sent for rewriting.

---

## Humanizer skill — how the rewriter uses it

`src/rewriter.ts` loads `docs/SKILL.md` at runtime and injects it as the system prompt (with an inline fallback if the file is missing). In full-file mode the user message contains the file path and full content; in `diff`/`chunk` modes it receives a numbered fragment and a fragment-mode system prompt, and must return only the rewritten fragment. In all cases the model returns content only — no markdown fences, no explanations.

When editing `src/rewriter.ts`, the temperature comes from `config.temperature` (default `0.4`) — low enough for consistency, high enough for variation. `sanitizeResponse` also strips stray markdown fences and a hallucinated leading path header before validating. `callModel` scales `max_tokens` with fragment size and **retries once** on `finish_reason=length` with a higher cap. Chunk mode **retries with half `maxChunkLines`** when the first pass changed nothing.

### Detect full file / rewrite scoped

`audit.ts` always runs `detectAI` on the **full staged file** (never diff-only scoring). The rewriter chooses scope via `resolveEffectiveRewriteScope` (`file`, `diff`, `chunk`, or `auto`): full file for small sources (`rewriteFullFileBelowLines`), diff hunks with `contextLines` for large files with small edits (`diff-hunks.ts`), chunks capped by `maxChunkLines` for mostly-new large files (`chunk-split.ts`). Parallel rewrites across **different staged files** use `rewriteConcurrency` (`mapPool` in `concurrency.ts`); hunks/chunks within one file are applied bottom-up sequentially so line numbers stay valid (`spliceSlice`). Per-request timeout scales with size via `scaledTimeoutMs`.

### Detection cache (`.bypasser.state.json`)

`audit.ts` skips re-scoring unchanged files: `cachedDetectionScore(state, path, hash)` returns a prior score when the content hash matches; otherwise the file is scored and `recordDetection` persists it. Successful rewrites are keyed by content hash via `recordRewrite` so `rewriteFile` can skip already-humanized content (`res.skipped`). `logger.ts` owns this sidecar store and tolerates legacy flat-map state.

### Truncation / integrity guards (never remove)

A rewrite must **never** silently lose or corrupt a file. This is a hard invariant: a model cut off at `max_tokens` produced a valid-looking response that passed the old sanitizer and was restaged over the original, destroying ~2000 lines of a file. Guards, all keeping the original on failure:

1. `finish_reason === "length"` — the model ran out of tokens (the only 100% reliable signal). Always rejects.
2. `looksTruncated()` (`rewriter.ts`) — unbalanced brackets outside strings/comments, or a line-count collapse. The bracket scan is **language-aware** (`hasUnbalancedBrackets` in `bracket-balance.ts`): it reads `lineComment` from the resolved `LanguageProfile` so a Python `# … .get()/.post() …` comment is not mistaken for code, and skips Python/Ruby triple-quoted docstrings and C-style block comments. **A C-only scan rejected valid Python files as "truncated" and committed the original slop — never regress to a `//`-only scanner.** The collapse ratio depends on `finishReason`: a clean `stop` tolerates legitimate compression down to `COMPRESSION_LINE_RATIO` (0.4); any other/unknown reason uses the stricter `TRUNCATION_LINE_RATIO` (0.75). Only meaningful for files ≥ `TRUNCATION_MIN_LINES` (12).
   - **Fragment scoping (`isFragment`):** the bracket half is a *whole-file* invariant, so it must **not** run on a diff/chunk *fragment*. A slice is an arbitrary line range of the file and legitimately begins/ends mid-block (e.g. starts on `)` and ends right after an opening `(`), so its brackets are unbalanced by construction. `sanitizeResponse`/`finalizeRewrite` take `isFragment`; `rewriteByDiff` and `rewriteByChunksInner` pass `true`, so fragments run only the line-collapse half (`lineCollapseOnly`) and rely on `validateAssembledFile` + `checkSyntax` for the assembled file. This is the same "do not parse isolated fragments" contract as `checkSyntax`. **Without it, every large Python/JS file whose hunk cut inside a multi-line call was rejected ("unbalanced brackets: N vs M lines") and committed un-humanized — the `scanner_app.py` incident.**
3. Chatbot prose / no recognisable code token (the original prose guard), plus a hallucinated path-header strip.
4. `looksIndentBroken()` (`rewrite-validate.ts`) — rejects a rewrite that systemically flattens indentation (correct tokens, wrong structure).
5. `looksStructurallyBroken()` (`rewrite-validate.ts`) — rejects a rewrite that drops too many top-level declarations (gated by `structuralCheck`).
6. `checkSyntax()` (`syntax-guard.ts`) — parses the **assembled** file with a real parser: Python via `compile()` through the `python`/`python3`/`py` interpreter, JSON via `JSON.parse`. Catches a *micro*-misindentation (a single line at the wrong level) that the conservative indent heuristic above deliberately ignores — the exact failure that produced an `IndentationError` in a ~2800-line Python file reassembled from LLM chunks. Best-effort: if no interpreter is found (`unavailable`) or the language has no cheap local parser (`unsupported`), it does **not** block. Applied in `validateAssembledFile()` (the whole-file backstop, which is what actually saves the case) and in `rewriteFullFile()`. New `InvalidReason: "syntax"`. Do **not** parse isolated fragments (a fragment without its parent `def` never parses alone → false rejects).

Chunk/diff assembly uses **`ASSEMBLY_FINISH` (`stop`)** semantics in `looksTruncated` so legitimate comment-stripping compression is not treated like an unknown cutoff. If full assembly checks fail but the spliced file still **parses** and has balanced brackets, `isSafePartialHumanization` keeps the **partial humanized** worktree instead of reverting to the original (`finishChunkOrDiffRewrite`).

All ratios live in `rewrite-constants.ts`. And the write itself is defensive: `restageFile()` (in `git.ts`) refuses empty content over a non-empty file, refuses a severe shrink (severe-shrink floor), copies the current content to `<path>.bak`, writes atomically (temp + rename), and retries `git add` with exponential backoff (`gitAddWithRetry`, 5 attempts) before rolling the worktree back to the backup (`restoreBackup`) so a failed re-stage never leaves a corrupted file. Do not weaken or bypass any of these — `test/rewriter.test.ts`, `test/restage.test.ts`, `test/indent-validate.test.ts`, and `test/syntax-guard.test.ts` lock them in.

---

## Hard rules (correctness over authenticity)

Never degrade security, critical error handling, or legibility to appear more human. A working file that scores slightly higher on an AI detector is better than a broken one that scores lower. The commit is never blocked on tool errors — `audit.ts` catches all rewrite failures and lets the commit proceed.

---

## Scope

This tool targets code authenticity for Git workflows. It is not for defeating plagiarism detectors or academic integrity systems, and names no specific detector. Reframe such requests toward genuine code quality and natural development style (see `docs/SKILL.md` → Limits).
