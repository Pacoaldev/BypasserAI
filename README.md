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

The detector is fully deterministic — no API calls, works in CI for free. The rewriter uses your configured model only on files that actually need it.

---

## Quick start

```bash
# 1. Install globally or in your project
npm install -g bypasser-ai
# or: npx bypasser-ai

# 2. Initialize config in your repo
bypasser init

# 3. Add your API key (or set env var)
export BYPASSER_API_KEY=sk-...

# 4. Install the pre-commit hook
bypasser install

# Done. Every commit is now scanned automatically.
```

---

## Commands

```bash
bypasser init                 # Create .bypasser.json with defaults
bypasser install              # Install pre-commit git hook
bypasser uninstall            # Remove pre-commit git hook

bypasser detect               # Score staged files, report AI signals
bypasser detect --verbose     # Show individual signal details per file

bypasser rewrite <file>       # Rewrite a specific file via the API

bypasser audit                # Detect + rewrite staged files above threshold
bypasser audit --dry-run      # Detect only, no API calls, no restaging
bypasser audit --verbose      # Show per-file details
```

---

## Configuration

Create `.bypasser.json` in your project root (or run `bypasser init`):

```json
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o",
  "threshold": 0.65,
  "maxTokens": 4096,
  "ignore": ["src/generated/**", "*.graphql"]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `baseURL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `model` | `gpt-4o` | Model name for your provider |
| `threshold` | `0.65` | AI-score above which rewrite triggers (0–1) |
| `maxTokens` | `4096` | Max tokens for rewrite response |
| `ignore` | `[]` | Extra glob patterns to skip |

### Environment variables (override .bypasser.json)

```bash
BYPASSER_API_KEY     # API key
BYPASSER_BASE_URL    # API base URL
BYPASSER_MODEL       # Model name
OPENAI_API_KEY       # Fallback if BYPASSER_API_KEY not set
```

### Compatible providers

Any endpoint that speaks the OpenAI chat completions protocol:

- OpenAI (`https://api.openai.com/v1`)
- Anthropic via proxy
- [Ollama](https://ollama.ai) (`http://localhost:11434/v1`) — local, no cost
- [LM Studio](https://lmstudio.ai) (`http://localhost:1234/v1`) — local, no cost
- [OpenRouter](https://openrouter.ai) (`https://openrouter.ai/api/v1`)
- [Groq](https://groq.com) (`https://api.groq.com/openai/v1`)

---

## What the detector checks

The detector scores six signal families without calling any API:

| Family | Examples |
|--------|---------|
| **Naming** | All identifiers fully descriptive, no `aux`/`tmp`/`idx`; over-engineered names like `processData`, `handleResult` |
| **Structure** | 100% uniform arrow functions; every function using the same early-return pattern; long method chains without intermediate vars |
| **Comments** | Narration comments (`// This function validates...`); JSDoc on every function |
| **Error handling** | Every `catch` with custom error class; every async function wrapped in `try/catch` |
| **Abstraction** | All repeated logic immediately extracted; interface for every small inline type |
| **Uniformity** | Zero short variable names; every function block following identical structure |

Files scoring below the threshold pass through untouched. Files above threshold go to the rewriter.

---

## Files always skipped

Lock files, build artifacts, config files, and generated content are never sent for rewriting:

`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `dist/**`, `build/**`, `.next/**`, `*.min.js`, `*.snap`, `*.json`, `*.yaml`, `*.yml`, `*.toml`

---

## Architecture

```
src/
  cli.ts        Entry point, command router
  config.ts     Config loader (.bypasser.json + env vars)
  detector.ts   Deterministic AI-pattern scorer
  rewriter.ts   OpenAI-compatible API client
  git.ts        Staged diff reader + file restager
  installer.ts  Pre-commit hook writer/remover
  audit.ts      Full pipeline: detect → rewrite → restage
  index.ts      Public library exports
docs/
  SKILL.md      Humanizer skill prompt (loaded by rewriter)
```

---

## Limits

- Does not apply to config files, lock files, or generated artifacts
- Never degrades correctness, security, or legibility to appear human
- Not intended for academic plagiarism evasion — only for natural Git authorship style
- The detector uses heuristics, not an AST parser; false positives are possible on unusual codebases
