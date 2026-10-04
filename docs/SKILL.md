# Humanizer skill (bilingual)

BypasserAI embeds this skill in the rewriter system prompt. Pick the language that matches your team or model; content is equivalent in both files.

| File | Language | Used by |
|------|----------|---------|
| **[SKILL.en.md](SKILL.en.md)** | English | Default at runtime (`loadSkillPrompt`) |
| **[SKILL.es.md](SKILL.es.md)** | Español | When `BYPASSER_SKILL_LOCALE=es` |

## Runtime selection

```bash
# Default — English skill
bypasser audit

# Spanish skill text sent to the model
export BYPASSER_SKILL_LOCALE=es   # PowerShell: $env:BYPASSER_SKILL_LOCALE = "es"
bypasser audit
```

## For coding agents

Apply the humanizer rules from **SKILL.en.md** or **SKILL.es.md** (same policy) whenever you edit source that will be committed—see [AGENTS.md](../AGENTS.md). Config files, lockfiles, and generated output are out of scope.

Quick links: [English skill](SKILL.en.md) · [Skill en español](SKILL.es.md)
