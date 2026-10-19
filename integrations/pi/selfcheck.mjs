// Self-check for the panel: the log parser, the history aggregation, and the
// widget the extension registers. Builds its cases in the scratch dir.
//
//   node integrations/pi/selfcheck.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bypasserPanel, { computeHistory, readEvents } from "./bypasser-panel.ts";

// Pi passes real theme tokens and a real TUI; the harness passes stubs that
// keep the text uncoloured so the assertions can read it.
const theme = { fg: (_token, text) => text, bold: (text) => text };
const tui = { requestRender() {} };

const event = (ts, files) => ({
  ts,
  iso: ts.replace(" ", "T") + "Z",
  provider: "api.openai.com",
  model: "gpt-4o-mini",
  totalFiles: files.length,
  rewrittenFiles: files.filter((f) => f.status === "rewritten").length,
  rejectedFiles: files.filter((f) => f.status === "rejected").length,
  errorFiles: 0,
  files,
});

const dir = mkdtempSync(join(tmpdir(), "bypasser-panel-"));
try {
  // Case 1: two valid runs, the newest one flagged a file that stayed rejected.
  const valid = [
    event("2026-10-08 22:00:00", [
      { path: "src/a.ts", score: 0.71, threshold: 0.65, status: "rewritten", signals: [{ family: "naming", weight: 0.5 }] },
    ]),
    event("2026-10-08 22:06:00", [
      { path: "src/a.ts", score: 0.8, threshold: 0.65, status: "rejected", reason: "structural" },
      { path: "src/b.ts", score: 0.1, threshold: 0.65, status: "ok" },
    ]),
  ];
  const log = join(dir, ".bypasser.log.jsonl");
  writeFileSync(log, valid.map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.equal(readEvents(dir).length, 2, "two complete runs parse");

  // Case 2: a killed hook left a half-written last line. It must be dropped
  // without losing the runs before it.
  writeFileSync(log, valid.map((e) => JSON.stringify(e)).join("\n") + '\n{"ts":"2026-10-08 22:0');
  const parsed = readEvents(dir);
  assert.equal(parsed.length, 2, "truncated last line is skipped, earlier runs survive");

  const h = computeHistory(parsed);
  assert.equal(h.runs, 2);
  assert.equal(h.totalFiles, 3);
  assert.equal(h.rewritten, 1);
  assert.equal(h.rejected, 1);
  assert.equal(h.flaggedFiles, 1, "src/a.ts is the only flagged file");
  assert.deepEqual(h.scoresByRun, [0.71, 0.8]);
  assert.deepEqual(h.hotspots, [{ path: "src/a.ts", unresolved: 1, flagged: 2 }]);

  // Case 3: no log at all is not an error.
  rmSync(log);
  assert.equal(readEvents(dir).length, 0, "missing log yields no events");

  // Case 4: the widget itself. Feed the extension the same way Pi does and
  // render it against the log from case 1.
  writeFileSync(log, valid.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, ".bypasser.json"), JSON.stringify({ threshold: 0.65, model: "gpt-4o-mini" }));

  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const notices = [];
  const ui = { widget: undefined };
  bypasserPanel({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerShortcut(shortcut, options) {
      shortcuts.set(shortcut, options);
    },
  });
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: {
      setWidget(key, content, options) {
        ui.widget = { key, content, options };
      },
      notify(message, type) {
        notices.push({ message, type });
      },
    },
  };

  handlers.get("session_start")(undefined, ctx);
  assert.equal(ui.widget.key, "bypasser-panel");
  assert.equal(ui.widget.options.placement, "belowEditor", "renders in the dock under the editor");

  const lines = ui.widget.content(tui, theme).render(120);
  const text = lines.join("\n");
  assert.ok(lines.length <= 22, `stays within the row budget (got ${lines.length})`);
  for (const wanted of ["BypasserAI · último run", "histórico de este proyecto", "umbral 0.65", "src/a.ts"]) {
    assert.ok(text.includes(wanted), `renders ${wanted}`);
  }
  assert.ok(!text.includes("undefined") && !text.includes("NaN"), "no undefined or NaN leaks into the panel");

  // Narrow terminals must not throw or overflow the width they are given.
  const narrow = ui.widget.content(tui, theme).render(80);
  for (const line of narrow) assert.ok(line.length <= 80, `line fits 80 columns: ${line}`);

  // Case 5: a run with more files than rows. The file list is what gives way —
  // the header, the totals and the config line must survive it.
  const many = Array.from({ length: 12 }, (_, i) => ({
    path: `src/module-${i}.ts`,
    score: 0.8,
    threshold: 0.65,
    status: i % 2 === 0 ? "rejected" : "rewritten",
    reason: "structural",
  }));
  writeFileSync(log, JSON.stringify(event("2026-10-08 23:00:00", many)) + "\n");
  const crowded = ui.widget.content(tui, theme).render(120);
  const crowdedText = crowded.join("\n");
  assert.ok(crowded.length <= 22, `row budget holds with 12 files (got ${crowded.length})`);
  for (const wanted of ["BypasserAI · último run", "histórico de este proyecto", "umbral 0.65", "más"]) {
    assert.ok(crowdedText.includes(wanted), `long file list still renders ${wanted}`);
  }

  handlers.get("session_shutdown")(undefined, ctx);
  assert.equal(ui.widget.content, undefined, "shutdown clears the widget");

  // Case 6: the right rail. A fake fullscreen host exposes a layout root, and
  // mounting must wrap it in an hstack that reserves the right column while the
  // dock widget goes quiet — otherwise the panel would paint twice.
  const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
  const root = {
    render: () => ["transcript"],
    invalidate() {},
    [LAYOUT_NODE]: () => ({ type: "vstack", entries: [] }),
  };
  const hostTui = { requestRender() {}, mode: "fullscreen", terminal: { columns: 200, rows: 40 }, layoutRoot: root };
  const railCtx = { cwd: dir, hasUI: true, ui: { theme, setWidget: (key, content, options) => (ui.widget = { key, content, options }), notify: (message, type) => notices.push({ message, type }) } };

  handlers.get("session_start")(undefined, railCtx);
  const docked = ui.widget.content(hostTui, theme); // the factory mounts the rail

  const node = root[LAYOUT_NODE]();
  assert.equal(node.type, "hstack", "fullscreen host gets a side-by-side layout");
  assert.equal(node.entries.length, 2, "transcript column plus rail column");
  assert.equal(node.entries[1].basis, 32, "rail reserves a fixed 32-column column");
  assert.deepEqual(docked.render(120), [], "dock stays empty while the rail owns the panel");

  const railLines = node.entries[1].component.render(32);
  const railText = railLines.join("\n");
  assert.ok(railLines.length > 0, "rail renders content");
  assert.ok(railText.includes("BypasserAI"), "rail shows the panel");
  for (const line of railLines) assert.ok(line.length <= 33, `rail line fits its column: ${line}`);

  // Narrow or regular-mode hosts keep the dock instead of squeezing the chat.
  root[LAYOUT_NODE] = () => ({ type: "vstack", entries: [] });
  const narrowHost = { ...hostTui, terminal: { columns: 90, rows: 40 } };
  handlers.get("session_start")(undefined, { ...railCtx, ui: { theme, setWidget: (k, c, o) => (ui.widget = { key: k, content: c, options: o }) } });
  const narrowDock = ui.widget.content(narrowHost, theme);
  assert.equal(root[LAYOUT_NODE]().type, "vstack", "narrow terminal is left alone");
  assert.ok(narrowDock.render(90).length > 0, "narrow terminal falls back to the dock");

  handlers.get("session_shutdown")(undefined, railCtx);

  // Case 7: coexistence with gentle-shell. Its rail is already an hstack with a
  // fixed-width last column; the panel must stack inside that column instead of
  // opening a second one (two rails would eat 82 columns of transcript).
  const shellRail = { render: () => ["shell status card"], invalidate() {} };
  const shellRoot = {
    render: () => [],
    invalidate() {},
    [LAYOUT_NODE]: () => ({
      type: "hstack",
      gap: 3,
      align: "stretch",
      entries: [
        { component: { render: () => [], invalidate() {} }, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: shellRail, basis: 50, grow: 0, shrink: 0, minSize: 50 },
      ],
    }),
  };
  const shellTui = { requestRender() {}, mode: "fullscreen", terminal: { columns: 200, rows: 44 }, layoutRoot: shellRoot };
  handlers.get("session_start")(undefined, { ...railCtx, ui: { theme, setWidget: (k, c, o) => (ui.widget = { key: k, content: c, options: o }) } });
  ui.widget.content(shellTui, theme);

  const shellNode = shellRoot[LAYOUT_NODE]();
  assert.equal(shellNode.type, "hstack", "the shell's hstack is preserved");
  assert.equal(shellNode.entries.length, 2, "no third column is added");
  assert.equal(shellNode.entries[1].basis, 50, "the shell keeps its 50-column rail");

  const column = shellNode.entries[1].component[LAYOUT_NODE]();
  assert.equal(column.type, "vstack", "the panel stacks under the shell card");
  assert.ok(column.entries[0].component.render(50).join("\n").includes("shell status card"), "shell card keeps its slot");
  assert.ok(column.entries[1].component.render(50).join("\n").includes("BypasserAI"), "panel renders in the same column");

  handlers.get("session_shutdown")(undefined, railCtx);

  // Case 8: the toggle. Hiding must give the columns back and showing must put
  // the column back exactly once — both through the command and the shortcut.
  assert.ok(commands.has("bypasser"), "a /bypasser command is registered");
  assert.ok(shortcuts.has("alt+t"), "alt+t is registered as the toggle key");

  const toggleRoot = {
    render: () => [],
    invalidate() {},
    [LAYOUT_NODE]: () => ({ type: "vstack", entries: [] }),
  };
  const toggleTui = { requestRender() {}, mode: "fullscreen", terminal: { columns: 200, rows: 44 }, layoutRoot: toggleRoot };
  handlers.get("session_start")(undefined, railCtx);
  ui.widget.content(toggleTui, theme);
  assert.equal(toggleRoot[LAYOUT_NODE]().type, "hstack", "panel starts visible");

  shortcuts.get("alt+t").handler(railCtx);
  assert.equal(toggleRoot[LAYOUT_NODE]().type, "vstack", "hiding restores the original layout");
  assert.deepEqual(ui.widget.content(toggleTui, theme).render(120), [], "hidden dock paints nothing");
  assert.match(notices.at(-1).message, /hidden/, "hiding is reported");

  commands.get("bypasser").handler("", railCtx);
  assert.equal(toggleRoot[LAYOUT_NODE]().type, "hstack", "showing brings the column back");
  assert.match(notices.at(-1).message, /visible/, "showing is reported");

  handlers.get("session_shutdown")(undefined, railCtx);

  // Case 9: regression — toggling after another extension wrapped on top.
  // The panel used to tear its wrapper down on hide; gentle-shell then wrapping
  // above it left the disposer off the top of the chain, and showing again
  // installed a second wrapper: two panels side by side. Count them instead of
  // trusting the layout shape.
  const lateRoot = {
    render: () => [],
    invalidate() {},
    [LAYOUT_NODE]: () => ({
      type: "vstack",
      gap: 0,
      align: "stretch",
      entries: [{ component: { render: () => ["transcript"], invalidate() {} }, basis: 0, grow: 1, shrink: 1, minSize: 1 }],
    }),
  };
  const lateTui = { requestRender() {}, mode: "fullscreen", terminal: { columns: 200, rows: 44 }, layoutRoot: lateRoot };
  handlers.get("session_start")(undefined, railCtx);
  ui.widget.content(lateTui, theme);

  // The shell installs its rail on top of ours, exactly as it does on resize.
  const below = lateRoot[LAYOUT_NODE];
  lateRoot[LAYOUT_NODE] = () => ({
    type: "hstack",
    gap: 3,
    align: "stretch",
    entries: [
      { component: { render: () => [], invalidate() {}, [LAYOUT_NODE]: below }, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: { render: () => ["SHELL"], invalidate() {} }, basis: 50, grow: 0, shrink: 0, minSize: 50 },
    ],
  });

  const countPanels = (node, seen = new Set()) => {
    if (!node?.entries) return 0;
    let total = 0;
    for (const entry of node.entries) {
      const component = entry.component;
      if (!component || seen.has(component)) continue;
      seen.add(component);
      try {
        if ((component.render(50) ?? []).join("\n").includes("BypasserAI")) total += 1;
      } catch (_err) {
        void _err;
      }
      if (typeof component[LAYOUT_NODE] === "function") {
        try {
          total += countPanels(component[LAYOUT_NODE](), seen);
        } catch (_err) {
          void _err;
        }
      }
    }
    return total;
  };

  assert.equal(countPanels(lateRoot[LAYOUT_NODE]()), 1, "one panel before toggling");
  shortcuts.get("alt+t").handler(railCtx);
  assert.equal(countPanels(lateRoot[LAYOUT_NODE]()), 0, "hiding removes the panel entirely");
  shortcuts.get("alt+t").handler(railCtx);
  assert.equal(countPanels(lateRoot[LAYOUT_NODE]()), 1, "showing again must not duplicate the panel");

  handlers.get("session_shutdown")(undefined, railCtx);

  console.log("selfcheck ok: parser, truncated line, history, widget render, rail, shell coexistence, toggle, no duplicate, shutdown");
} finally {
  rmSync(dir, { recursive: true, force: true });
}