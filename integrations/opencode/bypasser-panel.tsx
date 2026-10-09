// @ts-nocheck
/** @jsxImportSource @opentui/solid */
//
// bypasser-panel — shows BypasserAI audit data inside the OpenCode TUI.
//
// BypasserAI is a pre-commit hook that scores staged files for AI-generated
// patterns and (optionally) rewrites them. It writes artifacts in the host
// repo, next to the code:
//
//   .bypasser.log        human log (the [████░░░░░░] bars)
//   .bypasser.log.jsonl  structured, one JSON object per audit run
//   .bypasser.json       project config (threshold, model, …)
//
// This plugin reads the JSONL for the current project and renders:
//   · the LAST RUN (files, scores, sub-signal families, delta vs previous)
//   · a HISTORY view (totals, success rate, trend sparkline, hotspots)
//   · a small config line (threshold / model) when .bypasser.json exists.
// It renders a friendly placeholder when the project has no history.
//
// Data source of truth: https://github.com/Pacoaldev/BypasserAI (src/logger.ts)
// AuditLogEvent = { ts, iso, provider, model, totalFiles, rewrittenFiles,
//   rejectedFiles, errorFiles, files: [{ path, score, threshold, status,
//   reason?, signals?: [{ family, weight }] }] }

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

const id = "bypasser-panel"

const JSONL_FILE = ".bypasser.log.jsonl"
const CONFIG_FILE = ".bypasser.json"

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** Read + parse every valid JSONL audit event for a project directory. */
function readEvents(directory: string) {
  const path = resolve(directory, JSONL_FILE)
  if (!existsSync(path)) return []
  let raw = ""
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const events = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.files)) {
        events.push(parsed)
      }
    } catch {
      // skip corrupt / half-written line, keep the rest
    }
  }
  return events
}

/** Read project config (.bypasser.json) best-effort — never throws. */
function readConfig(directory: string) {
  const path = resolve(directory, CONFIG_FILE)
  if (!existsSync(path)) return null
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"))
    if (!cfg || typeof cfg !== "object") return null
    return cfg
  } catch {
    return null
  }
}

/** Aggregate all runs of a project. */
function computeHistory(events) {
  let totalFiles = 0
  let rewritten = 0
  let rejected = 0
  let errors = 0
  const flaggedPaths = new Set()
  const hotspots = new Map()
  const scoresByRun = []

  for (const ev of events) {
    totalFiles += ev.totalFiles ?? ev.files.length
    rewritten += ev.rewrittenFiles ?? 0
    rejected += ev.rejectedFiles ?? 0
    errors += ev.errorFiles ?? 0

    // Highest score seen in this run — the "how AI-shaped did we get" sample.
    let runMax = 0
    for (const f of ev.files) {
      const score = typeof f.score === "number" ? f.score : 0
      if (score > runMax) runMax = score
      if (score >= f.threshold) {
        flaggedPaths.add(f.path)
        const h = hotspots.get(f.path) ?? { path: f.path, unresolved: 0, flagged: 0 }
        h.flagged++
        if (f.status !== "rewritten" && f.status !== "ok") h.unresolved++
        hotspots.set(f.path, h)
      }
    }
    scoresByRun.push(runMax)
  }

  const attempts = rewritten + rejected + errors
  const pending = rejected + errors
  const worst = [...hotspots.values()]
    .filter((h) => h.unresolved > 0)
    .sort((a, b) => b.unresolved - a.unresolved || b.flagged - a.flagged)
    .slice(0, 3)

  return {
    runs: events.length,
    totalFiles,
    flaggedFiles: flaggedPaths.size,
    rewritten,
    rejected,
    errors,
    attempts,
    pending,
    successRate: attempts === 0 ? 0 : rewritten / attempts,
    hotspots: worst,
    scoresByRun,
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function bar(score, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(score * width)))
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]"
}

function pct(x) {
  return (x * 100).toFixed(0) + "%"
}

/** "2026-10-08T22:06:12.651Z" → "08 Oct 22:06" (fallback to raw ts). */
function fmtWhen(ev) {
  const iso = ev.iso || (ev.ts ? ev.ts.replace(" ", "T") + "Z" : "")
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ev.ts || "?"
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const p2 = (n) => String(n).padStart(2, "0")
  return `${p2(d.getDate())} ${months[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** "hace 3m / 2h / 5d" relative to now. */
function ago(ev) {
  const iso = ev.iso || (ev.ts ? ev.ts.replace(" ", "T") + "Z" : "")
  const d = new Date(iso).getTime()
  if (isNaN(d)) return ""
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000))
  if (s < 60) return `hace ${s}s`
  if (s < 3600) return `hace ${Math.floor(s / 60)}m`
  if (s < 86400) return `hace ${Math.floor(s / 3600)}h`
  return `hace ${Math.floor(s / 86400)}d`
}

function statusOf(f) {
  if (f.status === "rewritten") return { glyph: "✓", color: "#3fb950", label: "humanized" }
  if (f.status === "rejected") return { glyph: "✗", color: "#f85149", label: "rejected" }
  if (f.status === "error") return { glyph: "!", color: "#f85149", label: "error" }
  if (f.status === "skipped") return { glyph: "·", color: "#6e7681", label: "skipped" }
  if (f.status === "unresolved") return { glyph: "◆", color: "#d29922", label: "unresolved" }
  return { glyph: "✓", color: "#3fb950", label: "ok" }
}

function successColor(rate) {
  if (rate >= 0.8) return "#3fb950"
  if (rate >= 0.5) return "#d29922"
  return "#f85149"
}

/** Color a score for the metrics/bar. Higher score = more AI-shaped = worse. */
function scoreColor(score) {
  if (score >= 0.65) return "#ff7b72"
  if (score >= 0.4) return "#e3b341"
  return "#56d364"
}

/** Trim a path so the panel stays readable in a narrow sidebar. */
function shortPath(p, max = 34) {
  if (p.length <= max) return p
  return "…" + p.slice(p.length - (max - 1))
}

/** Unicode sparkline from a list of 0..1 samples. */
function sparkline(samples, width = 12) {
  const blocks = "▁▂▃▄▅▆▇█"
  const tail = samples.slice(-width)
  if (tail.length === 0) return ""
  return tail
    .map((s) => blocks[Math.max(0, Math.min(blocks.length - 1, Math.round(s * (blocks.length - 1))))])
    .join("")
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const FileRow = (props) => {
  const f = () => props.file
  const st = () => statusOf(f())
  const hasDelta = () => typeof props.delta === "number" && Math.abs(props.delta) >= 0.005
  const deltaText = () =>
    (props.delta < 0 ? "▼" : "▲") + (Math.abs(props.delta) * 100).toFixed(0)
  const deltaColor = () => (props.delta < 0 ? "#3fb950" : "#f85149")
  return (
    <box flexDirection="column">
      {/* Line 1: status glyph + path. Path is the only thing allowed to be
          long, so it owns its own line and can never push the metrics off. */}
      <box flexDirection="row">
        <text fg={st().color}>{st().glyph} </text>
        <text fg="#e6edf3">{shortPath(f().path, props.maxPath ?? 30)}</text>
      </box>
      {/* Line 2: score metrics, compact so they fit a narrow sidebar. */}
      <box flexDirection="row">
        <text fg="#6e7681">{"  "}</text>
        <text fg={scoreColor(f().score)}>{pct(f().score)}</text>
        <Show when={!props.tiny}>
          <text fg={st().color}> {st().label} </text>
        </Show>
        <text fg={scoreColor(f().score)}>{bar(f().score, props.tiny ? 8 : 10)}</text>
        <Show when={hasDelta()}>
          <text fg={deltaColor()}> {deltaText()}</text>
        </Show>
      </box>
      <Show when={f().reason}>
        <text fg="#8b949e">{"  " + shortPath(f().reason, props.maxPath ?? 40)}</text>
      </Show>
    </box>
  )
}

const LastRun = (props) => {
  const ev = () => props.event
  const prev = () => props.prev
  const prevByPath = createMemo(() => {
    const m = new Map()
    if (prev()) for (const f of prev().files) m.set(f.path, f.score)
    return m
  })
  return (
    <box flexDirection="column">
      <text fg="#ffb454">BypasserAI · último run</text>
      {/* Timestamp on its own short line so it never overflows. */}
      <text fg="#58a6ff">
        {fmtWhen(ev())} ({ago(ev())})
      </text>
      {/* One metric per line (not a wide "·"-joined row) so nothing is cut. */}
      <text fg="#e6edf3">
        {ev().totalFiles} archivos · {ev().rewrittenFiles} humanized
      </text>
      <Show when={(ev().rejectedFiles ?? 0) + (ev().errorFiles ?? 0) > 0}>
        <text fg="#ff7b72">
          {ev().rejectedFiles} rechazados · {ev().errorFiles} errores
        </text>
      </Show>
      <Show when={ev().files.length > 0}>
        <For each={ev().files.slice(0, props.maxFiles ?? 12)}>
          {(f) => (
            <FileRow
              file={f}
              maxPath={props.maxPath}
              tiny={props.tiny}
              delta={
                prevByPath().has(f.path) ? f.score - prevByPath().get(f.path) : undefined
              }
            />
          )}
        </For>
        <Show when={ev().files.length > (props.maxFiles ?? 12)}>
          <text fg="#8a8a8a">… {ev().files.length - (props.maxFiles ?? 12)} más</text>
        </Show>
      </Show>
    </box>
  )
}

const History = (props) => {
  const h = () => props.history
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg="#ffb454">histórico de este proyecto</text>
      <text fg="#e6edf3">
        {h().runs} runs · {h().totalFiles} escaneados
      </text>
      <text fg="#58a6ff">{h().flaggedFiles} flagged</text>
      {/* Split success line: "rewritten / rejected / errors" on one line,
          the rate (colored) on its own, never elided. */}
      <text fg="#8b949e">
        {h().rewritten} hum / {h().rejected} rech / {h().errors} err
      </text>
      <text fg={successColor(h().successRate)}>{pct(h().successRate)} éxito</text>
      <Show when={h().pending > 0}>
        <text fg="#ffa657">⚠ {h().pending} pendiente(s) sin humanizar</text>
      </Show>
      <Show when={h().scoresByRun.length > 1}>
        <text fg="#8b949e">tendencia {sparkline(h().scoresByRun)}</text>
      </Show>
      <Show when={h().hotspots.length > 0}>
        <text fg="#8b949e">se repiten sin mejorar:</text>
        <For each={h().hotspots}>
          {(s) => (
            <text fg="#ffa657">
              · {shortPath(s.path, props.maxPath ?? 26)} ({s.unresolved}/{s.flagged})
            </text>
          )}
        </For>
      </Show>
    </box>
  )
}

const ConfigLine = (props) => {
  const c = () => props.config
  const ev = () => props.event
  // Threshold is per-file in the JSONL; take it from the first file (same
  // config for the whole run unless per-glob thresholds are used).
  const runThreshold = () => {
    const f = ev()?.files?.find((x) => typeof x.threshold === "number")
    return f ? f.threshold : undefined
  }
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg="#56d4dd">umbral {c().threshold ?? "?"}</text>
      <Show when={c().model}>
        <text fg="#8b949e">{c().model}</text>
      </Show>
      <Show when={runThreshold() !== undefined && runThreshold() !== c().threshold}>
        <text fg="#8b949e">último run con umbral {runThreshold()}</text>
      </Show>
    </box>
  )
}

const Panel = (props) => {
  const api = props.api
  const dim = useTerminalDimensions()
  const [tick, setTick] = createSignal(0)

  // Refresh on a timer so the panel follows commits made OUTSIDE OpenCode (the
  // hook runs on `git commit`, which the TUI event bus never sees).
  const timer = setInterval(() => setTick((n) => n + 1), 5000)
  api.lifecycle.onDispose(() => clearInterval(timer))
  const unsubs = [
    api.event.on("session.idle", () => setTick((n) => n + 1)),
    api.event.on("session.updated", () => setTick((n) => n + 1)),
  ]
  api.lifecycle.onDispose(() => unsubs.forEach((u) => u()))

  const directory = () => api.state.path.directory

  const data = createMemo(() => {
    tick()
    const events = readEvents(directory())
    if (events.length === 0) return null
    return {
      last: events[events.length - 1],
      prev: events.length > 1 ? events[events.length - 2] : null,
      history: computeHistory(events),
      config: readConfig(directory()),
    }
  })

  const narrow = createMemo(() => dim().width < 90)
  const tiny = createMemo(() => dim().width < 60)
  const maxFiles = createMemo(() => (tiny() ? 5 : narrow() ? 6 : 12))
  const maxPath = createMemo(() => {
    const w = dim().width
    if (w < 46) return w - 12
    if (w < 60) return w - 14
    return w < 90 ? 30 : 40
  })

  return (
    <box flexDirection="column">
      <Show
        when={data()}
        fallback={
          <box flexDirection="column">
            <text fg="#8a8a8a">BypasserAI: sin historial</text>
          </box>
        }
      >
        {(d) => (
          <>
            <LastRun
              event={d().last}
              prev={d().prev}
              maxFiles={maxFiles()}
              maxPath={maxPath()}
              tiny={tiny()}
            />
            <History history={d().history} maxPath={maxPath()} />
            <Show when={d().config}>
              <ConfigLine config={d().config} event={d().last} />
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    id,
    order: 80,
    slots: {
      sidebar_footer() {
        return <Panel api={api} />
      },
    },
  })
}

const plugin = { id, tui }
export default plugin
