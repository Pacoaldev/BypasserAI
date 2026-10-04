---
name: humanizer
description: Human-like code authorship style. Apply when generating or editing source that will be committed to Git—even if not explicitly requested. Goal is natural developer voice and lower AI-pattern scores in IDEs, without sacrificing correctness.
locale: en
---

# Humanizer

Write code the way a competent **mid-level developer** would: working, readable, slightly uneven in places—not uniformly “RLHF-polished.” The aim is **natural Git authorship** and fewer AI-shaped tells in IDE scanners and pre-commit tooling—not gimmicks that break the build.

## When to apply

- New or edited **source code** and **comments** destined for a commit.
- Refactors that touch logic, structure, or naming in application code.

**Do not apply** to lockfiles, generated artifacts, pure config (`.json` / `.yaml` tooling configs), or one-off scripts the user marked as throwaway—unless they asked for humanization there too.

## Priorities

1. **Correctness first** — behavior, security, and project lint/format rules win.
2. **Project conventions beat this skill** — match existing style in the repo.
3. **Variation is subtle** — occasional imperfection, never chaos or unreadable code.

## Guidelines

### 1. Naming

- Keep the project’s public naming convention (usually camelCase in JS/TS; follow the file’s language).
- In **local, short-lived** variables, mix descriptive names with pragmatic short ones: `aux`, `tmp`, `val`, `res`, `idx`, `dataOk`, `checkUser`.
- Prefer habits a human would use (`res`, `total`, `usrIdx`) over ceremony (`finalOperationResultValue`).
- Do not introduce alien conventions (e.g. snake_case in a strict camelCodebase).

### 2. Structure and rhythm

- Where the language allows, **vary** equivalent forms (e.g. `function` vs arrow in JS; `def` vs a small comprehension in Python)—without fighting the formatter.
- Do not compress every algorithm into one “elegant” line; sometimes use a temporary (`tmp`, `res`) and two steps.
- Mixed quote styles only if the linter allows.
- **Never** fight Prettier, Black, ESLint auto-fix, etc.

### 3. Control flow

- Alternate patterns across functions: early returns in some, nested `if/else` in others.
- Avoid every function sharing the same guard → happy-path skeleton.

### 4. Comments

- Comment **sparingly**—only where logic is genuinely non-obvious.
- No narration of the obvious (`// increment counter`).
- When you do comment, use a natural tone: real `TODO`s, caveats, domain quirks.
- **Do not fabricate** history (fake tickets, fake incidents).

### 5. Pragmatic duplication (imperfect DRY)

- A repeated 3–4 line block can stay duplicated with `// TODO: extract helper` instead of instant abstraction.
- Occasional magic numbers/strings on narrow edge cases are OK if over-constantizing would be noise.
- Lazy typing where the project already allows: `any`, inline shapes, small inline types instead of a formal interface for every payload.

### 6. Error handling

- Not every `catch` needs a custom error type and rethrow choreography.
- Sometimes `catch (e) { console.error(e); return null; }` or best-effort try/catch on non-critical steps is enough—unless the codebase mandates stricter patterns.

### 7. Assistant-style replies (when this skill is used in chat)

- Ship code directly—no “Hope this helps!” preambles or postambles unless the user asked for explanation.
- Ask before generating when a real ambiguity changes behavior.

## Limits

- Do not add unrequested features, tests, debug scaffolding, or docs.
- **Never** weaken security, critical error handling, or clarity to “look human.”
- This skill targets **healthy Git workflow and code quality**, not academic plagiarism evasion or defeating integrity systems.
