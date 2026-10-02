<p align="center">
  <img src="assets/logo.png" alt="BypasserAI" width="480" />
</p>

# BypasserAI

A pre-commit hook and CLI that detects AI-generated code patterns in your staged diff and rewrites them via any OpenAI-compatible API, so your commits read as written by a human developer.

Works with any project — Node, React, Angular, Python, Go, whatever. Language-agnostic by design.

---

## How it works

```
git commit
    ↓
pre-commit hook
    ↓
reads staged diff
    ↓
detector scores each file (0–1, no API call, deterministic)
    ↓
score < threshold → passes through untouched
score ≥ threshold → sent to OpenAI-compatible API with humanizer skill
    ↓
rewritten content is re-staged automatically
    ↓
commit proceeds
```

The detector is fully deterministic — no API calls, works in CI for free. The rewriter only calls the API on files that actually score above the threshold.

---

## Prerequisites

- Node.js 18 or higher
- A git repository (the hook installs into `.git/hooks/`)
- An API key for any OpenAI-compatible provider (OpenAI, Groq, Ollama local, etc.)

---

## Installation

### Option A — Use directly from this repo (recommended while not yet on npm)

```bash
# 1. Clone the repo
git clone https://github.com/your-org/bypasser-ai.git
cd bypasser-ai

# 2. Install dependencies
npm install

# 3. Build the TypeScript source
npm run build

# 4. Link the CLI globally so you can run it from any project
npm link
```

After `npm link`, the `bypasser` command is available everywhere on your machine.

### Option B — Once published to npm

```bash
npm install -g bypasser-ai
# or use without installing: npx bypasser-ai <command>
```

---

## Setup in your project

Run these steps inside the project you want to protect — **not** inside the bypasser-ai repo itself.

```bash
# 1. Go to your project
cd my-project

# 2. Create the config file
bypasser init
```

> If `.bypasser.json` already exists, `bypasser init` leaves it untouched — it never overwrites an existing config (so you can't lose an `apiKey` or hand-tuned settings by re-running it). Pass `--force` to regenerate the defaults:
>
> ```bash
> bypasser init --force
> ```


This creates `.bypasser.json` in your project root:

```json
{
  "baseURL": "http://localhost:20128/v1",
  "model": "ag/claude-sonnet-4-6",
  "threshold": 0.65,
  "maxTokens": 16384,
  "temperature": 0.4,
  "ignore": [],
  "thresholds": []
}
```

```bash
# 3. Set your API key (never put it in .bypasser.json — use an env var)
export BYPASSER_API_KEY=sk-...

# On Windows (PowerShell):
$env:BYPASSER_API_KEY = "sk-..."

# 4. Install the pre-commit hook
bypasser install
```

That's it. From now on, every `git commit` in that project is scanned automatically.

---

## What happens on commit

Every commit triggers three things automatically — no terminal needed:

### 1. Windows toast notification

A native Windows notification appears in the corner of your screen:

- **BypasserAI — Clean** → all files passed, nothing rewritten
- **BypasserAI — Humanized** → one or more files were rewritten before commit
- **BypasserAI — Rewrite failed** → a file needed rewriting but the API call failed (check `.bypasser.log`)

Works in any IDE (Cursor, Kiro, Antigravity, OpenCode, Pi) without any extra setup. Uses BurntToast if installed; otherwise it fires a native WinRT toast that persists in the Windows Action Center. (The legacy balloon is only a last resort — Windows 11 deprecates it and dismisses it almost instantly.)

### 2. `.bypasser.log` file

A log file is created automatically in your project root and updated after every commit:

```
# bypasser-ai — commit scan log

── 2026-09-28 14:32:11 ─────────────────────────────────────
  src/utils.ts: 72% [███████░░░] ✓ humanized & re-staged
    ↳ [naming] Over-descriptive variable names (processData, handleResult)
    ↳ [comments] Comments describe what the code does (obvious narration)
  src/index.ts: 31% [███░░░░░░░] ✓ ok
  → 1 file(s) humanized and re-staged

── 2026-09-28 15:10:44 ─────────────────────────────────────
  src/api.py: 18% [██░░░░░░░░] ✓ ok
```

Open it once in your IDE and leave it as a tab — it updates automatically after each commit.

> `.bypasser.log` and `.bypasser.state.json` are automatically added to `.gitignore` by `bypasser init` and never committed.

### 3. Terminal output (when running manually)

If you run `bypasser audit --verbose` directly:

```
[src/utils.ts] score: 72%
  ✗ [naming] Over-descriptive variable names (processData, handleResult)
  ✗ [comments] Comments describe what the code does (obvious narration)

bypasser-ai — 2 file(s) scanned
  src/utils.ts: 72% [███████░░░] ✓ humanized & re-staged
  src/index.ts: 31% [███░░░░░░░] ✓ ok

  → 1 file(s) rewritten. Commit will use humanized version.
```

---

## Manual commands

You can also run the tool manually at any time:

```bash
# Create .bypasser.json (skips if it already exists)
bypasser init

# Overwrite an existing .bypasser.json with the defaults
bypasser init --force

# Check staged files without touching anything
bypasser detect

# Score the working tree WITHOUT staging — see the % while you edit
bypasser detect --all

# See which specific signals fired
bypasser detect --verbose

# Rewrite a specific file (not necessarily staged)
bypasser rewrite src/utils.ts

# Full pipeline on staged files: detect + rewrite + restage
bypasser audit

# Dry run: detect only, no API calls, no file changes
bypasser audit --dry-run

# Audit with per-file signal details
bypasser audit --verbose

# Remove the pre-commit hook
bypasser uninstall
```

---

## Configuration

`.bypasser.json` in your project root controls all behavior:

| Field | Default | Description |
|-------|---------|-------------|
| `baseURL` | `http://localhost:20128/v1` | Any OpenAI-compatible endpoint |
| `model` | `ag/claude-sonnet-4-6` | Model name for your provider |
| `threshold` | `0.65` | Score (0–1) above which rewrite triggers |
| `maxTokens` | `16384` | Max tokens for rewrite response |
| `temperature` | `0.4` | Sampling temperature for the rewrite (higher = more variation) |
| `ignore` | `[]` | Extra glob patterns to never rewrite |
| `thresholds` | `[]` | Per-glob threshold overrides, e.g. `[{ "pattern": "src/legacy/**", "value": 0.3 }]` (first match wins) |

### Environment variables

These override `.bypasser.json` and are the safe way to pass secrets:

| Variable | Description |
|----------|-------------|
| `BYPASSER_API_KEY` | Your API key |
| `BYPASSER_BASE_URL` | API base URL |
| `BYPASSER_MODEL` | Model name |
| `OPENAI_API_KEY` | Fallback if `BYPASSER_API_KEY` is not set |

### Compatible API providers

Anything that speaks the OpenAI chat completions protocol works:

| Provider | Base URL |
|----------|----------|
| OpenAI | `https://api.openai.com/v1` |
| [Groq](https://groq.com) (fast, free tier) | `https://api.groq.com/openai/v1` |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1` |
| [Ollama](https://ollama.ai) (local, no cost) | `http://localhost:11434/v1` |
| [LM Studio](https://lmstudio.ai) (local, no cost) | `http://localhost:1234/v1` |
| 9Router (local) | `http://localhost:20128/v1` |
| Anthropic via proxy | depends on proxy |

**9Router example config:**

```json
{
  "baseURL": "http://localhost:20128/v1",
  "model": "ag/claude-sonnet-4-6",
  "threshold": 0.65,
  "maxTokens": 16384,
  "temperature": 0.4,
  "ignore": []
}
```

> 9Router doesn't validate the API key but the SDK requires a non-empty value. Set `BYPASSER_API_KEY=local` or any placeholder string.

---

## Files always skipped

These are never sent for rewriting regardless of score:

`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `dist/**`, `build/**`, `.next/**`, `*.min.js`, `*.snap`, `*.json`, `*.yaml`, `*.yml`, `*.toml`

Add your own patterns in `.bypasser.json` → `ignore`.

---

## How the score works

The detector fires a **cluster** of correlated signals (naming + structure +
comments + uniformity) and maps their combined weight through a saturating
curve (`1 - e^(-w/2.5)`). This matters: AI-generated code rarely trips *every*
signal, so a plain "fired ÷ total" ratio would cap around 45% and never reach a
usable threshold. With the saturating curve, textbook AI code lands in the
**70–85%** band while ordinary human code stays **below ~50%**. The default
threshold is `0.65`.

A lone weak signal (descriptive names, a `try/catch`) is good practice rather
than proof of AI authorship — the curve already keeps it near ~0.15, well below
any usable threshold. The score is only a literal `0` when **no** signal fires
at all.

> **Language-agnostic by design.** The detector resolves a language profile from
> the file extension (JS/TS, Python, Go, Rust, Java, C#, C/C++, Ruby, PHP — with
> source-sniffing fallback). Every signal reads from that profile, so a 100%-AI
> Python file scores like a 100%-AI TypeScript one. This fixed the original
> bug where the detector only understood JavaScript syntax and reported **0%**
> on real AI Python/Go/Rust files, so they were never humanized.

---

## What the detector checks

The detector scores six signal families without calling any API:

| Family | What triggers it |
|--------|-----------------|
| **Naming** | All variables fully descriptive, no `aux`/`tmp`/`idx`; names like `processData`, `process_data` |
| **Structure** | Uniform function-declaration style; early-return guards everywhere; long method chains; exhaustive type annotations; lint-driven idioms (`void promise`, `x instanceof Error ? e.message`) |
| **Comments** | Short imperative narration (`// Validate the input`); *terse* docblocks on nearly every function |
| **Error handling** | Every `catch` with custom error class; every async function wrapped in `try/catch` |
| **Abstraction** | All repeated logic immediately extracted; a named type/payload for every small shape |
| **Uniformity** | Zero short variable names; every function block structurally identical; uniform JSX/Tailwind markup; exhaustive React hooks |

> Documentation is **not** penalised when it is genuinely informative: a
> docblock carrying `@param`/`@returns`/`Args:` annotations, or multi-line
> rationale explaining *why*, is treated as human. Only terse, restating
> docblocks on nearly every function are an AI tell — which is what keeps
> well-documented human codebases (Laravel, JSDoc-heavy TS) safe.

---

## Architecture

```
src/
  cli.ts        Entry point, command router
  config.ts     Config loader (.bypasser.json + env vars)
  detector.ts   Deterministic AI-pattern scorer (no API). Language-agnostic:
                resolves a per-language profile (JS/TS, Python, Go, Rust, Java,
                C#, C/C++, Ruby, PHP) and scores a cluster of weighted signals.
  rewriter.ts   OpenAI-compatible API client + humanizer prompt + response sanitizer
  git.ts        Staged diff reader + file restager
  installer.ts  Pre-commit hook writer/remover
  audit.ts      Full pipeline: detect → rewrite → restage → log → notify
  logger.ts     Appends timestamped results to .bypasser.log
  notifier.ts   Windows toast notifications (BurntToast → WinRT → balloon)
  index.ts      Public library exports
docs/
  SKILL.md      Humanizer skill prompt (loaded at runtime by rewriter.ts)
```

---

## Limits

- Does not apply to config files, lock files, or generated artifacts
- Never degrades correctness, security, or legibility to appear human
- Not intended for academic plagiarism evasion — only for natural Git authorship style
- The detector uses heuristics, not a full AST parser; false positives are possible on unusual codebases. Raise `threshold` if it fires too often, or use per-glob `thresholds` to relax it for legacy folders
- If a rewrite fails (API down, bad key), the commit is **never blocked**: the failure is reported in the terminal, written to `.bypasser.log`, and surfaced as an error toast

---

<a href="https://github.com/Gentleman-Programming/gentle-ai">
  <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
</a>
