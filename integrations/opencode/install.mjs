#!/usr/bin/env node
/**
 * install.mjs — register the BypasserAI TUI panel with OpenCode.
 *
 * What it does (idempotent, best-effort):
 *   1. Resolve the OpenCode config dir (~/.config/opencode, or $OPENCODE_CONFIG_DIR).
 *   2. Copy `bypasser-panel.tsx` into <config>/tui-plugins/.
 *   3. Add that plugin's ABSOLUTE path to the `plugin` array of <config>/tui.json,
 *      creating the file if missing and never duplicating an existing entry.
 *
 * It does NOT touch any other plugin, theme, or key in tui.json.
 *
 * Usage:
 *   node integrations/opencode/install.mjs          # install / update
 *   node integrations/opencode/install.mjs --print  # dry-run: show what it would write
 *   node integrations/opencode/install.mjs --uninstall
 *
 * The panel reads `.bypasser.log.jsonl` from the project OpenCode is opened in,
 * so it works for every repo where you installed the BypasserAI hook.
 */

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL_SRC = resolve(HERE, "bypasser-panel.tsx")
const PANEL_NAME = "bypasser-panel.tsx"

const args = process.argv.slice(2)
const dryRun = args.includes("--print")
const uninstall = args.includes("--uninstall")

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  // OpenCode follows the XDG base-dir convention on every platform.
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg ? xdg : join(homedir(), ".config")
  return join(base, "opencode")
}

const DIR = configDir()
const PLUGINS_DIR = join(DIR, "tui-plugins")
const PANEL_DEST = join(PLUGINS_DIR, PANEL_NAME)
const TUI_JSON = join(DIR, "tui.json")

function readTuiJson() {
  if (!existsSync(TUI_JSON)) {
    return { $schema: "https://opencode.ai/tui.json", plugin: [] }
  }
  try {
    const raw = JSON.parse(readFileSync(TUI_JSON, "utf8"))
    if (!raw || typeof raw !== "object") return { $schema: "https://opencode.ai/tui.json", plugin: [] }
    if (!Array.isArray(raw.plugin)) raw.plugin = []
    return raw
  } catch (err) {
    console.error(`! Could not parse ${TUI_JSON}: ${err.message}`)
    console.error("  Fix or remove it, then re-run. Aborting to avoid clobbering it.")
    process.exit(1)
  }
}

function writeTuiJson(obj) {
  if (dryRun) {
    console.log(`[dry-run] would write ${TUI_JSON}:`)
    console.log(JSON.stringify(obj, null, 2))
    return
  }
  mkdirSync(DIR, { recursive: true })
  writeFileSync(TUI_JSON, JSON.stringify(obj, null, 2) + "\n", "utf8")
}

console.log(`OpenCode config dir: ${DIR}`)

if (uninstall) {
  const cfg = readTuiJson()
  const before = cfg.plugin.length
  // Drop our absolute path AND any relative mention of the panel file.
  cfg.plugin = cfg.plugin.filter((p) => !String(p).includes(PANEL_NAME))
  writeTuiJson(cfg)
  if (existsSync(PANEL_DEST) && !dryRun) rmSync(PANEL_DEST, { force: true })
  console.log(
    `Removed ${before - cfg.plugin.length} plugin entr${before - cfg.plugin.length === 1 ? "y" : "ies"}.` +
      (existsSync(PANEL_DEST) && dryRun ? ` (would delete ${PANEL_DEST})` : "")
  )
  process.exit(0)
}

if (!existsSync(PANEL_SRC)) {
  console.error(`! Panel source not found at ${PANEL_SRC}`)
  process.exit(1)
}

// 1. Copy the panel into the OpenCode config tree.
if (!dryRun) {
  mkdirSync(PLUGINS_DIR, { recursive: true })
  copyFileSync(PANEL_SRC, PANEL_DEST)
}
console.log(`${dryRun ? "[dry-run] would copy" : "Copied"} panel → ${PANEL_DEST}`)

// 2. Register its absolute path in tui.json (no duplicates).
const cfg = readTuiJson()
const already = cfg.plugin.some((p) => String(p).includes(PANEL_NAME))
if (!already) {
  cfg.plugin.push(PANEL_DEST)
  console.log(`Registered plugin in ${TUI_JSON}`)
} else {
  console.log(`Plugin already registered in ${TUI_JSON} (path refreshed on disk)`)
}
writeTuiJson(cfg)

console.log("\nDone. Restart OpenCode to load the panel.")
console.log("It appears at the bottom of the right sidebar on any repo with a .bypasser.log.jsonl.")
