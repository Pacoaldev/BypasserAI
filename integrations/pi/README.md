# BypasserAI · Pi panel

A [Pi](https://github.com/earendil-works/pi) extension that shows your
**BypasserAI audit data inside the Pi TUI**, in a column at the right edge — the
same band OpenCode puts it in, and the one gentle-shell uses for its Status
card — for whichever project the session is running in.

Pi's public extension API only places widgets **above or below the editor**, so
the rail is built by wrapping the fullscreen layout root in a side-by-side
layout that reserves a 32-column column. When that is not possible — regular
(not fullscreen) mode, or a terminal narrower than 100 columns — the panel falls
back to the dock under the editor instead of squeezing the transcript.

If another extension already owns the right column, the panel **stacks inside
it** rather than opening a second one. This is the case with `gentle-pi`'s
shell, whose 50-column Status rail wraps the same layout root: the panel renders
under that card and reuses its width, so the transcript keeps its room.

```
BypasserAI · último run
api.openai.com · gpt-4o-mini
09 Oct 18:48 (hace 9m)
2 archivos · 1 humanized
✓ test-manual/ai-slop.ts
  61% humanized [████████░░] ▼7
✗ test-manual/human.ts
  0% rejected [░░░░░░░░░░]

histórico de este proyecto
5 runs · 30 escaneados
3 flagged
2 hum / 3 rech / 0 err
40% éxito
⚠ 3 pendiente(s) sin humanizar
tendencia ▃▅▆▇█
se repiten sin mejorar:
· src/notifier.ts (1/1)
· src/secrets.ts (1/1)

umbral 0.65
gpt-4o-mini
```

## What it shows

- **Last run** — provider · model, timestamp (`09 Oct 18:48` + `hace 9m`), the
  **per-file** score bar and status glyph, and a **delta arrow** (▲/▼) versus
  the previous run for that same file.
- **Project history** — runs, files scanned, flagged files,
  humanized/rejected/errors, success rate, **pending** files still not
  humanized, a **sparkline** of the worst score per run, and your repeat
  offenders (hotspots).
- **Config line** — the project `threshold` / `model` read from `.bypasser.json`.

Events written before `files[].signals` existed render fine, just without the
per-family breakdown. A project with no history gets a one-line placeholder; a
repo with `disable: true` says so. A half-written last JSONL line (a killed hook
process) is skipped without blanking the panel.
### Row budget

The dock and the rail share one renderer, so the panel stops at 22 rows. The
header, the totals and the config line always render; the per-file rows give way
first, then the hotspots list is dropped whole rather than half-shown. Hidden
files are counted on a `… N más` row. Change `MAX_ROWS` at the top of
`bypasser-panel.ts` if the dock feels tall or short — that is the one knob worth
tuning once you see
it live.

In the rail the same rows apply, capped to the terminal height, and the provider
and model split onto two lines when they do not fit the 32 columns.

Below 90 columns the paths are trimmed to 30 chars (40 at full width) and the
status label drops below 60.

## Data source

The panel reads, in the directory the Pi session runs in:

| File | Use |
|------|-----|
| `.bypasser.log.jsonl` | one JSON object per audit run (`src/logger.ts`) |
| `.bypasser.json` | project config (optional) |

No network, no API key: it only parses local files. Pi re-reads the log every
5 seconds, because the hook runs on `git commit` — an event the TUI never sees.

## Install

Requirements: **Pi** installed and **Node.js 18+**.

From a clone of this repo:

```bash
node integrations/pi/install.mjs
```

That copies `bypasser-panel.ts` into `<configDir>/extensions/`, which Pi
auto-loads. Then run `/reload` in Pi, or restart it.

- Config dir resolution: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` (works on
  Windows, macOS, Linux).
- Preview without writing: `node integrations/pi/install.mjs --print`
- Remove: `node integrations/pi/install.mjs --uninstall`

### Manual install

Copy `bypasser-panel.ts` to `~/.pi/agent/extensions/`. There is no registration
file: Pi loads every file in that directory.

### Showing and hiding it

Two ways, both momentary — the state is not persisted, so a restart brings the
panel back:

| Input | Effect |
| --- | --- |
| `/bypasser` | Toggles the panel and reports the new state |
| `alt+t` | Same toggle without leaving the prompt |

Hiding leaves the layout wrapper installed and simply has it return the original
layout node, so the transcript gets its full width back rather than keeping a
blank 32-column column. The wrapper is deliberately **not** torn down on hide:
another extension (`gentle-shell`) can wrap on top of it, which would leave the
disposer off the top of the chain and make showing again install a second
wrapper — two panels side by side. `alt+b` would be the better mnemonic but the
editor already binds it to `cursorWordLeft`.

### Verifying the parser

```bash
node integrations/pi/selfcheck.mjs
```

It builds two audit runs plus a truncated last line in a scratch directory and
asserts on what the parser and the history aggregation return, then drives the
extension exactly like Pi does (register → render → shutdown) and checks the
widget key, the `belowEditor` placement, the row budget with a 12-file run, that
the config line survives it, that a fake fullscreen host gets the right-hand
column wrapped in with the dock left empty, that an existing shell rail keeps
its column with the panel stacked underneath, that both the command and the
shortcut hide the column and restore the original layout, and that toggling
after another extension wrapped on top still leaves exactly one panel.