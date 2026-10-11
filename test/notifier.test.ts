import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "fs";
import {
  notifyWindows,
  buildScript,
  buildLaunch,
  readToastPayload,
  clearToastPayload,
  toastPayloadPath,
  toastScriptPath,
  BYPASSER_AUMID,
  _resetBurntToastCache,
  _setBurntToastAvailable,
} from "../src/notifier.js";

test("buildLaunch: is a deliberate no-op — Node never spawns PowerShell", () => {
  // Node used to spawn `cmd.exe /c powershell ...` here. That path either
  // failed to run the script (PowerShell GUI-subsystem + DETACHED_PROCESS
  // quirk) or flashed a console window for ~200-500 ms despite
  // `-WindowStyle Hidden`. We now write a .ps1 to disk and let the hook's
  // runner.vbs launch it via WScript.Shell.Run (never allocates a console).
  const r = buildLaunch("ignored");
  assert.deepEqual(r, { cmd: "", args: [] });
});

test("buildScript: shows a WinRT toast under our own registered AUMID", () => {
  _resetBurntToastCache();
  const script = buildScript();
  assert.match(script, /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.match(script, /CreateToastNotifier\(/);
  // Custom registered AUMID, not the well-known PowerShell one — Windows 11
  // silently filters toasts whose AUMID resolves to powershell.exe.
  assert.ok(script.includes(BYPASSER_AUMID));
  assert.doesNotMatch(script, /WindowsPowerShell.*powershell\.exe/);
});

test("buildScript: beeps as an audible backstop", () => {
  const script = buildScript();
  assert.match(script, /\[Console\]::Beep/);
});

test("buildScript: reads title/message from the payload file, never a command line", () => {
  // Reading from a file means user-provided text never has to be escaped
  // into a shell command line — no injection surface.
  const script = buildScript();
  assert.match(script, /Get-Content -Raw -Encoding UTF8 -LiteralPath/);
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /\$title = \[string\]\$o\.title/);
  assert.match(script, /\$msg = \[string\]\$o\.message/);
  // It self-cleans both temp files so %TEMP% does not accumulate debris.
  assert.match(script, /Remove-Item -LiteralPath/);
});

test("buildScript: forces -Encoding UTF8 so em-dashes/accents survive", () => {
  // Windows PowerShell 5.1 reads a BOM-less UTF-8 file as the ANSI code page
  // without an explicit -Encoding, mangling `—` and accented chars in the toast.
  const script = buildScript();
  assert.match(script, /Get-Content -Raw -Encoding UTF8 -LiteralPath/);
});

test("buildScript: bails out (no toast) when title and message are both blank", () => {
  // An empty payload must never produce a blank card the user can't read.
  const script = buildScript();
  assert.match(script, /IsNullOrWhiteSpace\(\$title\)/);
  assert.match(script, /IsNullOrWhiteSpace\(\$msg\)/);
});

test("notifyWindows: writes nothing when title and message are both blank", () => {
  // Hermetic: clear any payload/script left by a previous run first.
  clearToastPayload();
  try {
    unlinkSync(toastScriptPath());
  } catch {
    // nothing to clean
  }
  notifyWindows({ title: "   ", message: "" }, { platform: "win32" });
  // No payload → the runner has nothing to fire a blank toast with.
  assert.equal(readToastPayload(), null);
  // And no script either, so a stale script can't render an empty card.
  assert.equal(existsSync(toastScriptPath()), false);
  clearToastPayload();
});

test("notifyWindows: still writes when only one of title/message is blank", () => {
  clearToastPayload();
  notifyWindows({ title: "BypasserAI", message: "" }, { platform: "win32" });
  const p = readToastPayload();
  assert.ok(p, "a title-only toast is legitimate");
  assert.equal(p.title, "BypasserAI");
  clearToastPayload();
});

test("notifyWindows: no-op on non-Windows platforms", () => {
  clearToastPayload();
  notifyWindows({ title: "t", message: "m" }, { platform: "linux" });
  // On linux the notifier is a no-op — no payload file should ever appear.
  assert.equal(existsSync(toastPayloadPath()), false);
});

test("notifyWindows: writes the JSON payload and the PowerShell script", () => {
  notifyWindows(
    { title: "BypasserAI", message: "2 files rewritten", type: "warning" },
    { platform: "win32" }
  );

  const payload = readToastPayload();
  assert.ok(payload, "runner must be able to read the toast payload");
  assert.equal(payload.title, "BypasserAI");
  assert.equal(payload.message, "2 files rewritten");
  assert.equal(payload.type, "warning");

  // The .ps1 the runner will execute must also exist.
  assert.equal(existsSync(toastScriptPath()), true);

  clearToastPayload();
  assert.equal(readToastPayload(), null);
});

test("notifyWindows: special characters survive the JSON round-trip verbatim", () => {
  // Because the payload travels as JSON (not a command line), characters
  // that would have broken the old cmd-line encoding must pass through
  // untouched.
  notifyWindows(
    { title: "x'); rm -rf /; #", message: "$(evil) `tick` \"quote\"", type: "error" },
    { platform: "win32" }
  );
  const p = readToastPayload();
  assert.ok(p);
  assert.equal(p.title, "x'); rm -rf /; #");
  assert.equal(p.message, "$(evil) `tick` \"quote\"");
  assert.equal(p.type, "error");
  clearToastPayload();
});

test("notifyWindows: never blocks even if the disk write fails", () => {
  // Point TMP at a non-existent drive and confirm notifyWindows still
  // returns rather than throwing.
  const originalTmp = process.env.TMP;
  process.env.TMP = "Z:\\_definitely_not_a_real_path_\\x";
  try {
    notifyWindows({ title: "t", message: "m" }, { platform: "win32" });
  } finally {
    process.env.TMP = originalTmp;
  }
  // Reaching here without throwing honours the "never block the commit"
  // contract.
});
