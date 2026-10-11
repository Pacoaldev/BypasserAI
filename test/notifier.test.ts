import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

// ---------------------------------------------------------------------------
// Hermetic temp isolation.
//
// These tests exercise `notifyWindows`, which writes its toast payload to
// `os.tmpdir()` by default. On a machine where the CLI is linked globally, the
// REAL pre-commit runner VBScript reads that same `%TEMP%/bypasser-ai-toast.json`
// — so a test that leaves a payload behind makes the next commit show the test's
// dummy text as a real toast (the "BypasserAI: t / m" garbage-toast bug). Worse,
// `os.tmpdir()` caches its value at process start, so `process.env.TMP = ...`
// inside a test does NOT redirect it.
//
// Fix: every test that writes a toast passes an explicit `tmpDir` pointing at a
// private scratch dir, and cleans it up. Nothing ever touches the real %TEMP%.
// ---------------------------------------------------------------------------

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "bypasser-notify-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test("buildScript: honours an injected payload/script path", () => {
  const script = buildScript("C:/x/payload.json", "C:/x/script.ps1");
  assert.match(script, /C:\/x\/payload\.json/);
  assert.match(script, /C:\/x\/script\.ps1/);
});

test("notifyWindows: no-op on non-Windows platforms", () => {
  withTmp((dir) => {
    notifyWindows({ title: "t", message: "m" }, { platform: "linux", tmpDir: dir });
    // On linux the notifier is a no-op — no payload file should ever appear.
    assert.equal(existsSync(toastPayloadPath(dir)), false);
  });
});

test("notifyWindows: writes the JSON payload and the PowerShell script", () => {
  withTmp((dir) => {
    notifyWindows(
      { title: "BypasserAI", message: "2 files rewritten", type: "warning" },
      { platform: "win32", tmpDir: dir }
    );

    const payload = readToastPayload(dir);
    assert.ok(payload, "runner must be able to read the toast payload");
    assert.equal(payload.title, "BypasserAI");
    assert.equal(payload.message, "2 files rewritten");
    assert.equal(payload.type, "warning");

    // The .ps1 the runner will execute must also exist.
    assert.equal(existsSync(toastScriptPath(dir)), true);

    clearToastPayload(dir);
    assert.equal(readToastPayload(dir), null);
  });
});

test("notifyWindows: special characters survive the JSON round-trip verbatim", () => {
  // Because the payload travels as JSON (not a command line), characters
  // that would have broken the old cmd-line encoding must pass through
  // untouched.
  withTmp((dir) => {
    notifyWindows(
      { title: "x'); rm -rf /; #", message: "$(evil) `tick` \"quote\"", type: "error" },
      { platform: "win32", tmpDir: dir }
    );
    const p = readToastPayload(dir);
    assert.ok(p);
    assert.equal(p.title, "x'); rm -rf /; #");
    assert.equal(p.message, "$(evil) `tick` \"quote\"");
    assert.equal(p.type, "error");
    clearToastPayload(dir);
  });
});

test("notifyWindows: never blocks even if the disk write fails", () => {
  // Point the injected temp dir at a non-existent drive and confirm
  // notifyWindows still returns rather than throwing.
  notifyWindows(
    { title: "t", message: "m" },
    { platform: "win32", tmpDir: "Z:\\_definitely_not_a_real_path_\\x" }
  );
  // Reaching here without throwing honours the "never block the commit"
  // contract.
});

test("notifyWindows: writes nothing when title and message are both blank", () => {
  withTmp((dir) => {
    notifyWindows({ title: "   ", message: "" }, { platform: "win32", tmpDir: dir });
    // No payload → the runner has nothing to fire a blank toast with.
    assert.equal(readToastPayload(dir), null);
    // And no script either, so a stale script can't render an empty card.
    assert.equal(existsSync(toastScriptPath(dir)), false);
  });
});

test("notifyWindows: still writes when only one of title/message is blank", () => {
  withTmp((dir) => {
    notifyWindows({ title: "BypasserAI", message: "" }, { platform: "win32", tmpDir: dir });
    const p = readToastPayload(dir);
    assert.ok(p, "a title-only toast is legitimate");
    assert.equal(p.title, "BypasserAI");
    clearToastPayload(dir);
  });
});

test("notifyWindows: writes to the injected tmpDir, never the real %TEMP%", () => {
  // Regression for the "t"/"m" garbage toast: a test must never leave a payload
  // where the real pre-commit runner would pick it up.
  const realPayload = toastPayloadPath();
  const realScript = toastScriptPath();
  const realPayloadExisted = existsSync(realPayload);
  const realScriptExisted = existsSync(realScript);

  withTmp((dir) => {
    notifyWindows(
      { title: "SHOULD_NOT_ESCAPE", message: "isolated", type: "info" },
      { platform: "win32", tmpDir: dir }
    );
    assert.ok(existsSync(toastPayloadPath(dir)), "payload must land in the injected dir");
    assert.ok(existsSync(toastScriptPath(dir)), "script must land in the injected dir");
  });

  // The real system temp must be exactly as we found it — no payload written.
  if (!realPayloadExisted) {
    assert.equal(existsSync(realPayload), false, "real %TEMP% payload must not be created");
  }
  if (!realScriptExisted) {
    assert.equal(existsSync(realScript), false, "real %TEMP% script must not be created");
  }
});
