# BypasserAI · OpenCode panel

A [TUI plugin](https://opencode.ai/docs/tui) that shows your **BypasserAI audit
data inside OpenCode**, at the bottom of the right sidebar, for whichever
project you have open.

```
BypasserAI · último run
09 Oct 18:48 (hace 9m)
zd/claude-sonnet-4-5
2 archivos · 0 humanized
0 rechazados · 0 errores
✓ test-manual/ai-slop.ts
  61% humanized [████████░░] ▲3
✓ test-manual/human.ts
  0% humanized [░░░░░░░░░░]

histórico de este proyecto
5 runs · 30 escaneados
3 flagged
2 hum / 3 rech / 0 err
40% éxito
⚠ 3 pendiente(s) sin humanizar
tendencia ▃▅▆▇█
(score máx/run)
se repiten sin mejorar:
· src/notifier.ts (1/1)
· src/secrets.ts (1/1)

umbral 0.65
zd/claude-sonnet-4-5
```

## What it shows

- **Last run** — timestamp (`09 Oct 18:48` + `hace 9m`), model, per-file score
  bar and status glyph, the **per-family signals** that fired (`naming`,
  `structure`, `comments`, `errors`, `abstr`, `uniform`), and a **delta arrow**
  (▲/▼) versus the previous run for that same file.
- **Project history** — runs, files scanned, flagged files, humanized/rejected/
  errors, success rate, **pending** files still not humanized, a **sparkline**
  of the worst score per run, and your repeat offenders (hotspots).
- **Config line** — the project `threshold` / `model` read from `.bypasser.json`.

### Narrow-sidebar layout

The sidebar is often ~44 columns wide, where a single wide `·`-joined row gets
elided by the renderer (`zd…`, `0 humanized ·…`). So every metric group gets its
own short line, and each file takes **two lines** — glyph + path, then the
score metrics below it — so a long path can never push the score off-screen.
Below 60 columns it also drops the status label and the per-family breakdown,
and trims paths to the actual width. Nothing is cut.

It renders a friendly placeholder on projects with no BypasserAI history, and
tolerates a half-written last JSONL line (a killed hook process never blanks the
panel).

## Data source

The panel reads, in the project OpenCode is opened in:

| File | Use |
|------|-----|
| `.bypasser.log.jsonl` | one JSON object per audit run (`src/logger.ts`) |
| `.bypasser.json` | project config (optional) |

No network, no API key: it only parses local files. `signals` per file are
written by BypasserAI ≥ the version that added this integration; older events
(without `signals`) render fine, just without the family breakdown.

## Install

Requirements: **OpenCode** installed and **Node.js 18+**.

From a clone of this repo:

```bash
node integrations/opencode/install.mjs
```

That copies `bypasser-panel.tsx` into `<opencode-config>/tui-plugins/` and adds
its absolute path to `<opencode-config>/tui.json` (creating the file if needed,
never duplicating the entry, never touching other plugins/theme).

- Config dir resolution: `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`,
  else `~/.config/opencode` (works on Windows, macOS, Linux).
- Preview without writing: `node integrations/opencode/install.mjs --print`
- Remove: `node integrations/opencode/install.mjs --uninstall`

Then **restart OpenCode**. Open any repo where you installed the BypasserAI hook
and committed at least once — the panel appears under the sidebar.

### Manual install

If you prefer to do it by hand:

1. Copy `bypasser-panel.tsx` to `~/.config/opencode/tui-plugins/`.
2. Add its absolute path to the `plugin` array in `~/.config/opencode/tui.json`:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": [
       "/absolute/path/to/.config/opencode/tui-plugins/bypasser-panel.tsx"
     ]
   }
   ```
