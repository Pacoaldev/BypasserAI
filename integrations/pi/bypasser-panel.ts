//
// bypasser-panel — shows BypasserAI audit data inside the Pi TUI.
//
// BypasserAI is a pre-commit hook that scores staged files for AI-generated
// patterns and (optionally) rewrites them. It writes artifacts in the host
// repo, next to the code:
//
//   .bypasser.log        human log (the [████░░░░░░] bars)
//   .bypasser.log.jsonl  structured, one JSON object per audit run
//   .bypasser.json       project config (threshold, model, …)
//
// This extension reads the JSONL for the session's project and renders, in the
// dock under the editor (the same band where gentle-shell prints its Status
// row): the LAST RUN (files, scores, delta vs the previous run), a HISTORY
// summary (totals, success rate, trend sparkline, hotspots) and a config line.
//
// Data source of truth: https://github.com/Pacoaldev/BypasserAI (src/logger.ts)
// AuditLogEvent = { ts, iso, provider, model, totalFiles, rewrittenFiles,
//   rejectedFiles, errorFiles, files: [{ path, score, threshold, status,
//   reason?, signals?: [{ family, weight }] }] }

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Pi supplies these at runtime; the shapes are declared here so the file stays
// standalone (no import of the Pi package, no build step).
type Theme = { fg(token: string, text: string): string; bold(text: string): string };
type Tui = { requestRender(): void };
type Widget = { render(width: number): string[] };
type WidgetContent = ((tui: Tui, theme: Theme) => Widget) | string[] | undefined;
type UiContext = {
  setWidget(key: string, content: WidgetContent, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  theme: Theme;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};
type Context = { cwd: string; hasUI: boolean; ui: UiContext };
type ExtensionAPI = {
  on(event: string, handler: (event: unknown, ctx: Context) => void): void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: Context) => void | Promise<void> }): void;
  registerShortcut(shortcut: string, options: { description?: string; handler: (ctx: Context) => void | Promise<void> }): void;
};

// Pi's fullscreen layout is a tree of layout nodes, and the symbol is the only
// way to reach it from an extension: `setWidget` can only place content above
// or below the editor, never in a column beside it. Wrapping the root in an
// hstack is how the shell's own rail reserves a right-hand column.
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type LayoutNode = {
  type: string;
  entries?: unknown[];
  gap?: number;
  align?: "stretch" | "start" | "center" | "end";
};
type StackEntry = {
  component: { render(width: number): string[]; invalidate(): void; [LAYOUT_NODE]?: () => LayoutNode };
  basis?: number | "auto";
  grow?: number;
  shrink?: number;
  minSize?: number;
};
type StackNode = { type: "hstack" | "vstack"; entries: StackEntry[]; gap: number; align: "stretch" | "start" | "center" | "end" };
type LayoutRoot = { render(width: number): string[]; invalidate(): void; [LAYOUT_NODE]?: () => LayoutNode };
type HostTui = Tui & { mode?: string; layoutRoot?: LayoutRoot; terminal?: { columns: number; rows: number } };

type Signal = { family: string; weight: number };
type AuditFile = { path: string; score: number; threshold?: number; status?: string; reason?: string; signals?: Signal[] };
type AuditEvent = {
  ts?: string;
  iso?: string;
  provider?: string;
  model?: string;
  totalFiles?: number;
  rewrittenFiles?: number;
  rejectedFiles?: number;
  errorFiles?: number;
  files: AuditFile[];
};
type ProjectConfig = { threshold?: number; model?: string; disable?: boolean; rewriteScope?: string };

const WIDGET_KEY = "bypasser-panel";
const JSONL_FILE = ".bypasser.log.jsonl";
const CONFIG_FILE = ".bypasser.json";
const REFRESH_MS = 5000;
// Toggle keys. `alt+b` would be the obvious mnemonic but the editor already
// binds it to cursorWordLeft, so the panel takes a key nothing else claims.
const TOGGLE_SHORTCUT = "alt+t";
const TOGGLE_COMMAND = "bypasser";
// The rail is a fixed-width column at the right edge, the same band the shell's
// own status card uses. Wide enough for the panel's labels, narrow enough to
// leave the transcript most of the terminal.
const RAIL_WIDTH = 32;
// Below this the transcript has no room left to give, so the panel falls back
// to the dock under the editor instead of squeezing the chat.
const RAIL_MIN_COLUMNS = 100;
// The dock is shared with the prompt, so the panel is capped to a readable
// band. The header, the totals and the config line always render; the per-file
// rows give way first, then the hotspots. Lower this if the dock feels tall.
const MAX_ROWS = 22;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** Read + parse every valid JSONL audit event for a project directory. */
export function readEvents(directory: string): AuditEvent[] {
  const path = resolve(directory, JSONL_FILE);
  if (!existsSync(path)) return [];
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.files)) {
        events.push(parsed as AuditEvent);
      }
    } catch {
      // skip the corrupt / half-written line, keep the rest
    }
  }
  return events;
}

/** Read project config (.bypasser.json) best-effort — never throws. */
function readConfig(directory: string): ProjectConfig | null {
  const path = resolve(directory, CONFIG_FILE);
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (!cfg || typeof cfg !== "object") return null;
    return cfg as ProjectConfig;
  } catch {
    return null;
  }
}

export type History = {
  runs: number;
  totalFiles: number;
  flaggedFiles: number;
  rewritten: number;
  rejected: number;
  errors: number;
  attempts: number;
  pending: number;
  successRate: number;
  hotspots: { path: string; unresolved: number; flagged: number }[];
  scoresByRun: number[];
};

/** Aggregate every run of a project. */
export function computeHistory(events: AuditEvent[]): History {
  let totalFiles = 0;
  let rewritten = 0;
  let rejected = 0;
  let errors = 0;
  const flaggedPaths = new Set<string>();
  const hotspots = new Map<string, { path: string; unresolved: number; flagged: number }>();
  const scoresByRun: number[] = [];

  for (const ev of events) {
    totalFiles += ev.totalFiles ?? ev.files.length;
    rewritten += ev.rewrittenFiles ?? 0;
    rejected += ev.rejectedFiles ?? 0;
    errors += ev.errorFiles ?? 0;

    // Worst score of the run — the "how AI-shaped did we get" sample.
    let runMax = 0;
    for (const f of ev.files) {
      const score = typeof f.score === "number" ? f.score : 0;
      if (score > runMax) runMax = score;
      if (score >= (f.threshold ?? 1)) {
        flaggedPaths.add(f.path);
        const h = hotspots.get(f.path) ?? { path: f.path, unresolved: 0, flagged: 0 };
        h.flagged++;
        if (f.status !== "rewritten" && f.status !== "ok") h.unresolved++;
        hotspots.set(f.path, h);
      }
    }
    scoresByRun.push(runMax);
  }

  const attempts = rewritten + rejected + errors;
  const worst = [...hotspots.values()]
    .filter((h) => h.unresolved > 0)
    .sort((a, b) => b.unresolved - a.unresolved || b.flagged - a.flagged)
    .slice(0, 3);

  return {
    runs: events.length,
    totalFiles,
    flaggedFiles: flaggedPaths.size,
    rewritten,
    rejected,
    errors,
    attempts,
    pending: rejected + errors,
    successRate: attempts === 0 ? 0 : rewritten / attempts,
    hotspots: worst,
    scoresByRun,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function bar(score: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(score * width)));
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

function pct(x: number): string {
  return (x * 100).toFixed(0) + "%";
}

/** "2026-10-08T22:06:12.651Z" → "08 Oct 22:06" (falls back to the raw ts). */
function fmtWhen(ev: AuditEvent): string {
  const iso = isoOf(ev);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return ev.ts || "?";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getDate())} ${months[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function isoOf(ev: AuditEvent): string {
  return ev.iso || (ev.ts ? ev.ts.replace(" ", "T") + "Z" : "");
}

/** "hace 3m" / "2h" / "5d" relative to now. */
function ago(ev: AuditEvent): string {
  const t = new Date(isoOf(ev)).getTime();
  if (isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)}m`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)}h`;
  return `hace ${Math.floor(s / 86400)}d`;
}

/** Theme token per status, plus the glyph and the label shown next to it. */
function statusOf(f: AuditFile): { glyph: string; token: string; label: string } {
  if (f.status === "rewritten") return { glyph: "✓", token: "success", label: "humanized" };
  if (f.status === "rejected") return { glyph: "✗", token: "error", label: "rejected" };
  if (f.status === "error") return { glyph: "!", token: "error", label: "error" };
  if (f.status === "skipped") return { glyph: "·", token: "dim", label: "skipped" };
  if (f.status === "unresolved") return { glyph: "◆", token: "warning", label: "unresolved" };
  return { glyph: "✓", token: "success", label: "ok" };
}

function successToken(rate: number): string {
  if (rate >= 0.8) return "success";
  if (rate >= 0.5) return "warning";
  return "error";
}

/** Higher score = more AI-shaped = worse. */
function scoreToken(score: number): string {
  if (score >= 0.65) return "error";
  if (score >= 0.4) return "warning";
  return "success";
}

/** Trim a long path from the left, where the repo prefix is the least useful. */
function shortPath(p: string, max: number): string {
  const cap = Math.max(12, max);
  if (p.length <= cap) return p;
  return "…" + p.slice(p.length - (cap - 1));
}

/** Unicode sparkline from a list of 0..1 samples. */
function sparkline(samples: number[], width = 12): string {
  const blocks = "▁▂▃▄▅▆▇█";
  const tail = samples.slice(-width);
  if (tail.length === 0) return "";
  return tail
    .map((s) => blocks[Math.max(0, Math.min(blocks.length - 1, Math.round(s * (blocks.length - 1))))])
    .join("");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function lastRunHeaderLines(ev: AuditEvent, theme: Theme, width: number): string[] {
  const lines: string[] = [theme.bold(theme.fg("accent", "BypasserAI · último run"))];

  // Provider and model share one row when they fit and split when they do not:
  // in the 32-column rail the pair never fits on one line.
  const origin = [ev.provider, ev.model].filter(Boolean).join(" · ");
  if (origin) {
    if (origin.length <= width) lines.push(theme.fg("muted", origin));
    else {
      if (ev.provider) lines.push(theme.fg("muted", ev.provider));
      if (ev.model) lines.push(theme.fg("muted", ev.model));
    }
  }
  lines.push(theme.fg("accent", `${fmtWhen(ev)} (${ago(ev)})`));
  lines.push(`${ev.totalFiles ?? ev.files.length} archivos · ${ev.rewrittenFiles ?? 0} humanized`);

  const failed = (ev.rejectedFiles ?? 0) + (ev.errorFiles ?? 0);
  if (failed > 0) {
    lines.push(theme.fg("error", `${ev.rejectedFiles ?? 0} rechazados · ${ev.errorFiles ?? 0} errores`));
  }
  return lines;
}

/** True when the file fits in the rows the panel has left. */
function fileRowCost(f: AuditFile): number {
  return f.reason ? 3 : 2;
}

/** Per-file detail, taking files until `budget` rows are used up. */
function fileRows(
  ev: AuditEvent,
  prev: AuditEvent | null,
  theme: Theme,
  maxPath: number,
  tiny: boolean,
  budget: number,
): { lines: string[]; kept: number } {
  const lines: string[] = [];
  const prevScores = new Map<string, number>();
  if (prev) for (const f of prev.files) prevScores.set(f.path, f.score);

  let used = 0;
  let kept = 0;
  for (const f of ev.files) {
    const cost = fileRowCost(f);
    if (used + cost > budget) break;
    used += cost;
    kept++;

    const st = statusOf(f);
    // The path owns its own line: it is the only long field, so it can never
    // push the score metrics off the row.
    lines.push(theme.fg(st.token, st.glyph + " ") + shortPath(f.path, maxPath));
    let metrics = "  " + theme.fg(scoreToken(f.score), pct(f.score));
    if (!tiny) metrics += " " + theme.fg(st.token, st.label);
    metrics += " " + theme.fg(scoreToken(f.score), bar(f.score, tiny ? 8 : 10));
    const delta = prevScores.has(f.path) ? f.score - prevScores.get(f.path)! : undefined;
    if (delta !== undefined && Math.abs(delta) >= 0.005) {
      metrics += " " + theme.fg(delta < 0 ? "success" : "error", (delta < 0 ? "▼" : "▲") + Math.abs(delta * 100).toFixed(0));
    }
    lines.push(metrics);
    if (f.reason) lines.push(theme.fg("muted", "  " + shortPath(f.reason, maxPath + 10)));
  }
  return { lines, kept };
}

function historyGroups(h: History, theme: Theme, maxPath: number): { core: string[]; extras: string[]; hotspots: string[] } {
  const core: string[] = [
    "",
    theme.bold(theme.fg("accent", "histórico de este proyecto")),
    `${h.runs} runs · ${h.totalFiles} escaneados`,
    theme.fg("accent", `${h.flaggedFiles} flagged`),
    theme.fg("muted", `${h.rewritten} hum / ${h.rejected} rech / ${h.errors} err`),
    theme.fg(successToken(h.successRate), `${pct(h.successRate)} éxito`),
  ];
  const extras: string[] = [];
  if (h.pending > 0) extras.push(theme.fg("warning", `⚠ ${h.pending} pendiente(s) sin humanizar`));
  if (h.scoresByRun.length > 1) extras.push(theme.fg("muted", `tendencia ${sparkline(h.scoresByRun)}`));

  // All-or-nothing: half a hotspot list reads as if there were no other.
  const hotspots: string[] = [];
  const repeat = h.hotspots.slice(0, 2);
  if (repeat.length > 0) {
    hotspots.push(theme.fg("muted", "se repiten sin mejorar:"));
    for (const s of repeat) {
      hotspots.push(theme.fg("warning", `· ${shortPath(s.path, maxPath)} (${s.unresolved}/${s.flagged})`));
    }
  }
  return { core, extras, hotspots };
}

function configLines(config: ProjectConfig, last: AuditEvent, theme: Theme): string[] {
  const lines: string[] = [""];
  lines.push(theme.fg("accent", `umbral ${config.threshold ?? "?"}`));
  if (config.model) lines.push(theme.fg("muted", config.model));
  // Threshold is per file in the JSONL; the first one carries the run's config
  // unless per-glob thresholds are in play.
  const runThreshold = last.files.find((f) => typeof f.threshold === "number")?.threshold;
  if (runThreshold !== undefined && runThreshold !== config.threshold) {
    lines.push(theme.fg("muted", `último run con umbral ${runThreshold}`));
  }
  return lines;
}

function renderPanel(directory: string, theme: Theme, width: number): string[] {
  const config = readConfig(directory);
  const events = readEvents(directory);

  if (events.length === 0) {
    const idle = [theme.fg("dim", "BypasserAI: sin historial")];
    if (config?.disable) idle.push(theme.fg("dim", "BypasserAI: desactivado (disable: true)"));
    return idle;
  }

  const tiny = width < 60;
  const narrow = width < 90;
  const maxPath = width < 46 ? width - 12 : width < 60 ? width - 14 : narrow ? 30 : 40;

  const last = events[events.length - 1];
  const prev = events.length > 1 ? events[events.length - 2] : null;
  const header = lastRunHeaderLines(last, theme, width);
  const history = historyGroups(computeHistory(events), theme, narrow ? 26 : 34);
  const configBlock = config ? configLines(config, last, theme) : [];
  const historyRows = [...history.core, ...history.extras];

  // The file list gives way first, then the hotspots: the header, the totals
  // and the config line are always on screen.
  let budget = MAX_ROWS - header.length - historyRows.length - configBlock.length - 1;
  const rows = budget > 0 ? fileRows(last, prev, theme, maxPath, tiny, budget) : { lines: [], kept: 0 };
  const truncated = rows.kept < last.files.length;
  budget -= rows.lines.length + (truncated ? 1 : 0);

  const lines = [...header, ...rows.lines];
  if (truncated) lines.push(theme.fg("dim", `… ${last.files.length - rows.kept} más`));
  lines.push(...historyRows);
  if (budget >= history.hotspots.length) lines.push(...history.hotspots);
  lines.push(...configBlock);
  return lines;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** True when the rail can take the right edge: fullscreen, wide, layout exposed. */
function railEligible(tui: HostTui): boolean {
  return (
    tui.mode === "fullscreen" &&
    (tui.terminal?.columns ?? 0) >= RAIL_MIN_COLUMNS &&
    typeof tui.layoutRoot?.[LAYOUT_NODE] === "function"
  );
}

type PanelController = {
  dispose(): void;
  toggle(): boolean;
  isVisible(): boolean;
};

/**
 * Rail content, top-aligned like a sidebar card: the column is full height, so
 * padding it to the bottom would leave the panel floating with a tall gap above
 * it.
 */
function renderRail(directory: string, theme: Theme, width: number, rows: number): string[] {
  const contentWidth = Math.max(12, width - 2);
  let lines = renderPanel(directory, theme, contentWidth);
  // Never taller than the column it lives in.
  if (rows > 0 && lines.length > rows) lines = lines.slice(0, rows);
  return lines.map((line) => " " + line);
}

/**
 * The right-hand column another extension already installed, if any. gentle-shell
 * wraps the same layout root in an `hstack` whose last entry is a fixed-width
 * column; adding a second one would put two rails side by side, so the panel
 * composes into that column instead.
 */
function existingRailEntry(node: LayoutNode): { index: number; entry: StackEntry } | undefined {
  if (node.type !== "hstack" || !node.entries || node.entries.length < 2) return undefined;
  const index = node.entries.length - 1;
  const entry = node.entries[index] as StackEntry;
  const fixed = entry.grow === 0 && typeof entry.basis === "number" && entry.basis > 0;
  return fixed ? { index, entry } : undefined;
}

/**
 * Wrap the fullscreen layout root in an hstack that reserves a column at the
 * right edge for the panel. Returns undefined when the host exposes no layout
 * tree, in which case the caller keeps the dock widget instead.
 */
function installRail(
  tui: HostTui,
  theme: Theme,
  directory: string,
  isVisible: () => boolean,
): (() => void) | undefined {
  const root = tui.layoutRoot;
  if (!root || typeof root[LAYOUT_NODE] !== "function") return undefined;

  const original = root[LAYOUT_NODE]!;

  const rail = {
    render: (width: number) => {
      try {
        if (!isVisible()) return [];
        return railEligible(tui) ? renderRail(directory, theme, width, tui.terminal?.rows ?? 0) : [];
      } catch {
        return [];
      }
    },
    invalidate() {},
  };

  // `left` defers to whatever wrapper was there before (the shell's own rail
  // installs one too), so the two compose instead of replacing each other.
  const left = {
    render: () => [],
    invalidate() {},
    [LAYOUT_NODE]: () => original.call(root),
  };

  /** Panel stacked under an existing rail in the same column. */
  const stacked = (host: StackEntry["component"]) => ({
    render: () => [],
    invalidate() {},
    [LAYOUT_NODE]: (): LayoutNode => ({
      type: "vstack",
      gap: 0,
      align: "stretch",
      entries: [
        { component: host, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: rail, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
      ],
    }),
  });

  const wrapped = (): LayoutNode => {
    const node = original.call(root);
    if (!railEligible(tui) || !isVisible()) return node;

    const existing = existingRailEntry(node);
    if (existing) {
      const entries = (node as StackNode).entries.map((entry, index) =>
        index === existing.index ? { ...entry, component: stacked(entry.component) } : entry,
      );
      return { ...(node as StackNode), entries };
    }

    return {
      type: "hstack",
      gap: 1,
      align: "stretch",
      entries: [
        { component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: rail, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH },
      ],
    };
  };

  root[LAYOUT_NODE] = wrapped;

  return () => {
    // Only undo our own wrapper: another extension may have wrapped on top of
    // it, and stealing the slot back would drop that one's column too.
    if (root[LAYOUT_NODE] === wrapped) root[LAYOUT_NODE] = original;
  };
}

function attach(ctx: Context): PanelController {
  const directory = ctx.cwd;
  let tui: HostTui | undefined;
  let disposeRail: (() => void) | undefined;
  // Visibility is the one piece of state the toggle flips. It is deliberately
  // not persisted: a hidden panel is a momentary "get out of the way", not a
  // preference, and a panel that silently stayed gone after a restart would
  // look broken.
  let visible = true;

  const mountRail = (theme: Theme) => {
    if (disposeRail || !tui || !railEligible(tui)) return;
    disposeRail = installRail(tui, theme, directory, () => visible);
  };

  // The rail takes the right edge when it can; the dock widget is the fallback
  // for regular mode and narrow terminals, and paints nothing while the rail
  // owns the panel so the two never show it twice.
  ctx.ui.setWidget(
    WIDGET_KEY,
    (t, theme) => {
      tui = t as HostTui;
      // Pi hands the host TUI to this factory before the first paint, which is
      // the earliest point the layout root is reachable. Mounting here means
      // the rail is up on the first frame, not one refresh later.
      mountRail(theme);
      return {
        render: (width: number) => {
          if (!visible) return [];
          if (!tui || railEligible(tui)) return [];
          return renderPanel(directory, theme, width);
        },
      };
    },
    { placement: "belowEditor" },
  );

  // The hook runs on `git commit`, which the TUI never reports, so the panel
  // re-reads the log on a slow timer. A terminal that was too narrow at startup
  // and has since been widened gets its rail on the same tick. The timer is
  // unref'd so it never keeps the process alive on its own.
  const timer = setInterval(() => {
    mountRail(ctx.ui.theme);
    tui?.requestRender();
  }, REFRESH_MS);
  (timer as { unref?: () => void }).unref?.();

  const dispose = () => {
    clearInterval(timer);
    disposeRail?.();
    disposeRail = undefined;
  };

  /** Flip the panel and report the new state. */
  const toggle = (): boolean => {
    visible = !visible;
    // The wrapper stays installed and simply returns the original layout node
    // while hidden, so the transcript already gets its full width back. Tearing
    // it down here would be wrong: another extension (gentle-shell) may have
    // wrapped on top of us in the meantime, our disposer would then find itself
    // off the top of the chain and skip, and showing again would install a
    // second wrapper — two panels, side by side.
    tui?.requestRender();
    return visible;
  };

  return { dispose, toggle, isVisible: () => visible };
}

export default function bypasserPanel(pi: ExtensionAPI) {
  let panel: PanelController | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    panel?.dispose();
    panel = attach(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    panel?.dispose();
    panel = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  // Two ways in: a slash command for discoverability and a shortcut for the
  // in-the-moment "this is in my way" case.
  const notify = (ctx: Context, message: string, type: "info" | "warning" | "error") => {
    // `notify` is present on every interactive context; the guard keeps the
    // toggle harmless under harnesses and headless runs instead of throwing.
    if (typeof ctx.ui.notify === "function") ctx.ui.notify(message, type);
  };

  const toggle = (ctx: Context) => {
    if (!panel) {
      notify(ctx, "BypasserAI: panel is not attached in this session.", "warning");
      return;
    }
    const visible = panel.toggle();
    notify(ctx, visible ? "BypasserAI: panel visible." : "BypasserAI: panel hidden.", "info");
  };

  pi.registerCommand(TOGGLE_COMMAND, {
    description: "Show or hide the BypasserAI panel",
    handler: (_args, ctx) => toggle(ctx),
  });

  pi.registerShortcut(TOGGLE_SHORTCUT, {
    description: "Toggle the BypasserAI panel",
    handler: (ctx) => toggle(ctx),
  });
}