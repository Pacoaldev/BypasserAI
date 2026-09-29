import { spawn } from "child_process";

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

// Well-known AppUserModelID for Windows PowerShell. Registering the toast under
// it is what makes the notification persist in the Action Center; an arbitrary
// AUMID is silently dropped by Windows.
export const POWERSHELL_AUMID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

// Cache whether BurntToast is available so we don't pay a PowerShell cold
// start probing it on *every* commit. `undefined` = not probed yet.
let burntToastAvailable: boolean | undefined;

/**
 * Fire a Windows toast notification, non-blocking.
 *
 * The commit must never wait on a UI toast, so this spawns a detached
 * PowerShell process and returns immediately. Prefers BurntToast when
 * installed, then the native WinRT toast (which persists in the Action
 * Center), and only falls back to the legacy balloon last — Windows 11
 * deprecates that balloon and drops it almost immediately.
 */
export function notifyWindows(opts: NotifyOptions, deps: NotifyDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? spawn;

  // Notifications are a Windows nicety — no-op elsewhere.
  if (platform !== "win32") return;

  const { title, message, type = "info" } = opts;
  const icon =
    type === "error" ? "Error" : type === "warning" ? "Warning" : "Information";

  const script = buildScript(icon);
  const { cmd, args } = buildLaunch(script);

  try {
    const child = spawnFn(cmd, args, {
      // Pass payload via env — no string interpolation, no injection surface.
      env: { ...process.env, BYPASSER_TOAST_TITLE: title, BYPASSER_TOAST_MSG: message },
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } catch {
    // never block the commit because of a notification
  }
}

/**
 * Build the (command, args) pair that launches PowerShell on Windows.
 *
 * Windows gotcha we hit in the field: `spawn("powershell", [...], { detached:
 * true, stdio: "ignore" })` makes PowerShell exit with code 0 **without running
 * the script** (a known Node/Windows DETACHED_PROCESS quirk) — so the toast
 * never appeared. Dropping `detached` is not an option either: the pre-commit
 * hook calls `process.exit(0)` immediately, which kills a plain child before
 * PowerShell's ~1s cold start finishes.
 *
 * Wrapping the launch in `cmd /c start "" /b` breaks the process out of the
 * parent's job object so it survives the hook exiting, and `-EncodedCommand`
 * (UTF-16LE base64) sidesteps every cmd.exe quoting/newline hazard in the
 * multi-line script.
 */
export function buildLaunch(script: string): { cmd: string; args: string[] } {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return {
    cmd: "cmd",
    args: [
      "/c",
      "start",
      "",
      "/b",
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ],
  };
}

/**
 * Build the PowerShell script. Values are read from env vars, never inlined,
 * so quotes/`$`/backticks in the title or message cannot break out. When the
 * BurntToast probe has already failed (cached), that block is omitted so the
 * caller does not pay a second cold start.
 */
export function buildScript(icon: string): string {
  const useBurntToast = burntToastAvailable !== false;
  const burntToastBlock = useBurntToast
    ? `
if (Get-Module -ListAvailable -Name BurntToast) {
  Import-Module BurntToast -ErrorAction SilentlyContinue
  New-BurntToastNotification -Text $title, $msg | Out-Null
  exit 0
}
`
    : "";

  return `
$ErrorActionPreference = 'Stop'
$title = $env:BYPASSER_TOAST_TITLE
$msg = $env:BYPASSER_TOAST_MSG
${burntToastBlock}
# Native WinRT toast under the PowerShell AUMID — persists in the Action Center.
# The legacy System.Windows.Forms balloon below is only a last resort: Windows 11
# deprecates it and dismisses it almost instantly, which is why the toast was
# invisible before.
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $safeTitle = [System.Security.SecurityElement]::Escape($title)
  $safeMsg = [System.Security.SecurityElement]::Escape($msg)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast duration="long"><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text><text>' + $safeMsg + '</text></binding></visual></toast>')
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}').Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::${icon}
  $n.BalloonTipTitle = $title
  $n.BalloonTipText = $msg
  $n.BalloonTipIcon = '${icon}'
  $n.Visible = $true
  $n.ShowBalloonTip(6000)
  Start-Sleep -Milliseconds 6500
  $n.Dispose()
}
`.trim();
}

/** Reset the cached BurntToast probe — test-only. */
export function _resetBurntToastCache(): void {
  burntToastAvailable = undefined;
}

/** Record the cached BurntToast probe result — test-only. */
export function _setBurntToastAvailable(value: boolean): void {
  burntToastAvailable = value;
}
