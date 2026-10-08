import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { NotificationMode } from "./config.js";

export interface NotifyOptions {
  title: string;
  message: string;
  /** "info" | "warning" | "error" — maps to toast icon */
  type?: "info" | "warning" | "error";
}

export interface NotifyDeps {
  /** Platform to target; injectable for tests. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Spawn function, injectable for tests. Defaults to child_process.spawn. */
  spawnFn?: typeof spawn;
}

// Well-known AppUserModelID we register at install time. PowerShell's own
// AUMID ({1AC14E77-...}\WindowsPowerShell\v1.0\powershell.exe) is silently
// filtered by Windows 11's Action Center pipeline for security reasons (the
// pipeline rejects toasts whose AUMID resolves to a built-in console host
// invoked with -EncodedCommand), which makes the toast "delivered" to the
// per-AUMID counter but never actually surfaced on screen. Registering a
// custom AUMID lets us appear in Configuración → Notificaciones as a normal
// app and the toast then renders reliably across Win10/Win11 builds.
//
// The installer writes this AUMID under
// HKCU\Software\Classes\AppUserModelId\BypasserAI.Notifier; see installer.ts.
export const BYPASSER_AUMID = "BypasserAI.Notifier";

/** @deprecated — kept for callers that still import the name. */
export const POWERSHELL_AUMID = BYPASSER_AUMID;

// Cache whether BurntToast is available so we don't pay a PowerShell cold
// start probing it on *every* commit. `undefined` = not probed yet.

/**
 * Fire a Windows toast notification, non-blocking.
 *
 * The commit must never wait on a UI toast. We deliberately do NOT spawn
 * PowerShell from Node here — see `buildLaunch` for why that path always
 * either fails to run the script or flickers a console window in the
 * middle of the user's desktop. Instead we write the toast payload to a
 * small JSON file under `${TEMP}/bypasser-ai-toast.json`. The pre-commit
 * hook's `runner.vbs` checks for that file after the audit process returns
 * and, if present, dispatches the toast via `WScript.Shell.Run` (hidden).
 *
 * The file is best-effort: if the write fails (no TMP, disk full, …) the
 * commit must not be blocked. The hook will simply not fire a toast.
 */
export function notifyWindows(opts: NotifyOptions, deps: NotifyDeps = {}): void {
  const platform = deps.platform ?? process.platform;

  // Notifications are a Windows nicety — no-op elsewhere.
  if (platform !== "win32") return;

  const { title, message, type = "info" } = opts;

  try {
    const payload = JSON.stringify({
      title: String(title),
      message: String(message),
      type,
      // A nonce lets the runner skip stale payloads left over from a
      // previous commit whose runner never ran (e.g. crash).
      nonce: Date.now() + ":" + Math.random().toString(36).slice(2, 10),
    });
    writeFileSync(toastPayloadPath(), payload, "utf8");
    // Write the PowerShell script that the hook runner will execute
    // (hidden, via WScript.Shell.Run WindowStyle=0). Node never spawns
    // PowerShell itself — see buildLaunch for why.
    writeFileSync(toastScriptPath(), buildScript(), "utf8");
  } catch {
    // never block the commit because of a notification
  }
}

/** Absolute path to the toast payload file the runner reads. */
export function toastPayloadPath(): string {
  return join(tmpdir(), "bypasser-ai-toast.json");
}

/** Absolute path to the PowerShell script the runner executes. */
export function toastScriptPath(): string {
  return join(tmpdir(), "bypasser-ai-toast.ps1");
}

/**
 * Read the toast payload written by `notifyWindows`, if any. Returns
 * `null` when the file is missing or unreadable. Exported for the runner
 * VBScript via a side-channel; the hook invokes this from WSH.
 */
export function readToastPayload(): { title: string; message: string; type: string } | null {
  try {
    const p = toastPayloadPath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Delete the toast payload file after it has been consumed. */
export function clearToastPayload(): void {
  try {
    const p = toastPayloadPath();
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best-effort
  }
}

/**
 * Build the (command, args) pair that launches PowerShell on Windows.
 *
 * Node-driven spawn of PowerShell has two failure modes that we have hit in
 * the field and cannot accept:
 *
 *   1. `spawn("powershell.exe", [...], { detached: true, stdio: "ignore" })`
 *      makes PowerShell exit with code 0 *without running the script*
 *      (Node + Windows GUI subsystem `DETACHED_PROCESS` quirk) — the toast
 *      never appears.
 *
 *   2. `spawn("cmd.exe", ["/c", "powershell", ..., "-WindowStyle", "Hidden",
 *      "-EncodedCommand", ...], { detached: true, windowsHide: true })` runs
 *      the script, but cmd.exe + PowerShell briefly allocate a console
 *      window in the middle of the desktop despite `-WindowStyle Hidden`.
 *      On Windows 11 the console is owned by the GUI subsystem and the flag
 *      is ignored for ~200-500 ms while the process spins up. The user sees
 *      a black window flash for half a second every commit, which is the
 *      exact thing this code path exists to avoid.
 *
 * The reliable path is to have the pre-commit hook's `runner.vbs` (a WSH
 * script already invoked hidden by the .cmd trampoline) fire the toast
 * *after* the audit process returns. `WScript.Shell.Run` with
 * `WindowStyle=0` (hidden) and `Wait=false` is the Windows-native way to
 * spawn a process invisibly — it never allocates a console, it survives
 * the parent's exit, and it does not flicker.
 *
 * The Node side therefore does NOT spawn PowerShell at all. It writes the
 * toast payload (title, message, icon) to a small JSON file under
 * `${TEMP}/bypasser-ai-toast.json`. The runner.vbs checks for that file
 * after the audit returns and, if present, dispatches the toast via WSH
 * Run. This indirection is what removes the window flash.
 */
export function buildLaunch(_script: string): { cmd: string; args: string[] } {
  // Intentionally no-op: Node no longer spawns anything. The script argument
  // is accepted (and ignored) for backward compatibility with tests and
  // external callers.
  return { cmd: "", args: [] };
}

/**
 * Build the PowerShell toast script that the hook runner executes.
 *
 * The script is written to disk by `notifyWindows` and launched by
 * `pre-commit-runner.vbs` with `WScript.Shell.Run` at WindowStyle=0
 * (hidden). Node itself never spawns PowerShell: spawning it from Node
 * either fails to run the script (detached GUI-subsystem quirk) or
 * flashes a console window for ~200-500 ms despite `-WindowStyle Hidden`.
 *
 * The script reads the title/message from the JSON payload file written
 * alongside it, so user-provided text is never interpolated into a shell
 * command line. It then:
 *   1. binds the process to our registered AUMID (BypasserAI.Notifier),
 *   2. shows a WinRT toast that persists in the Action Center,
 *   3. beeps as an audible backstop,
 *   4. deletes both temp files so nothing accumulates in %TEMP%.
 */
export function buildScript(): string {
  // Embed the payload path as a PowerShell single-quoted literal. The path
  // comes from os.tmpdir() — controlled, never user input — so it is safe.
  const payloadPath = toastPayloadPath().replace(/'/g, "''");
  const scriptPath = toastScriptPath().replace(/'/g, "''");

  return `
$ErrorActionPreference = 'Stop'

# Read the toast payload written by the Node notifier. Reading from a file
# (rather than a command line) means title/message need no shell escaping.
$payload = Get-Content -Raw -LiteralPath '${payloadPath}'
$o = $payload | ConvertFrom-Json
$title = [string]$o.title
$msg = [string]$o.message

# Primary path: WinRT toast under our own registered AppUserModelID
# (BypasserAI.Notifier, registered by the installer). The toast persists in
# the Action Center just like any other app's notification. We deliberately
# do NOT use the well-known PowerShell AUMID: Windows 11 silently filters
# toasts whose AUMID resolves to powershell.exe + -EncodedCommand (the
# per-AUMID counter still ticks up but the toast never visually surfaces).
try {
  # Bind this PowerShell process to our AUMID before creating the notifier.
  # Without this Windows treats the toast as coming from an unknown process
  # and silently filters it on Windows 11.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class A {
  [DllImport("shell32.dll", PreserveSig=false)]
  public static extern void SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string AppID);
}
'@
  [A]::SetCurrentProcessExplicitAppUserModelID('${BYPASSER_AUMID}')

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $safeTitle = [System.Security.SecurityElement]::Escape($title)
  $safeMsg = [System.Security.SecurityElement]::Escape($msg)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast duration="long"><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text><text>' + $safeMsg + '</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${BYPASSER_AUMID}').Show($toast)
} catch {
  # WinRT threw (rare) — fall through to the audible beep below.
}

# Audible feedback as a backstop. If the toast subsystem silently dropped
# the notification (Focus Assist, broken shell, etc.) the user still gets a
# discrete "ding" so they know something fired.
try { [Console]::Beep(880, 180) } catch { }

# Self-clean the two temp files so %TEMP% does not accumulate toast debris.
# Best-effort: failures here must never surface to the user.
try { Remove-Item -LiteralPath '${payloadPath}' -Force -ErrorAction SilentlyContinue } catch { }
try { Remove-Item -LiteralPath '${scriptPath}' -Force -ErrorAction SilentlyContinue } catch { }
exit 0
`.trim();
}

/** @deprecated — no longer used; kept as a no-op for external callers. */
export function _resetBurntToastCache(): void {}

/** @deprecated — no longer used; kept as a no-op for external callers. */
export function _setBurntToastAvailable(_value: boolean): void {}

// ---------------------------------------------------------------------------
// Cross-platform notification dispatch
//
// Windows keeps the queue/VBScript pipeline above (it is the only OS where
// spawning a notifier from inside a git hook is guaranteed not to flash a
// console). macOS and Linux get a direct, best-effort shell call. All paths are
// fire-and-forget: a notification must never delay or fail a commit.
// ---------------------------------------------------------------------------

/** Notification mode resolved from config. (Re-exported from config.ts.) */
export type { NotificationMode } from "./config.js";

/** The command that shows a notification on the current platform, or null. */
export function notificationCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string
): { cmd: string; args: string[] } | null {
  if (platform === "darwin") {
    // AppleScript: escape backslashes and double quotes for the `-e` literal.
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      cmd: "osascript",
      args: [
        "-e",
        `display notification "${esc(message)}" with title "${esc(title)}"`,
      ],
    };
  }
  if (platform === "linux") {
    // notify-send is part of libnotify; the args array avoids shell quoting.
    return { cmd: "notify-send", args: [title, message] };
  }
  return null; // windows handled by notifyWindows(); others: nothing
}

/**
 * Platform-agnostic, opt-in notification. Dispatches to the Windows toast
 * pipeline or a macOS/Linux shell notifier. A no-op when `mode` is `"off"` or
 * on an unsupported platform. Never throws, never blocks the commit.
 */
export function notify(
  opts: NotifyOptions & { mode?: NotificationMode },
  deps: NotifyDeps = {}
): void {
  if ((opts.mode ?? "auto") === "off") return;

  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    notifyWindows(opts, deps);
    return;
  }

  const command = notificationCommand(platform, opts.title, opts.message);
  if (!command) return;

  try {
    const spawnFn = deps.spawnFn ?? spawn;
    const child = spawnFn(command.cmd, command.args, {
      stdio: "ignore",
      detached: true,
    });
    // Detach so the notifier outlives the hook process; ignore is requested but
    // guard anyway since a missing stdio array can still yield a stream.
    child.unref?.();
  } catch {
    // never block the commit because of a notification
  }
}
