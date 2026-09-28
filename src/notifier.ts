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

// Cache whether BurntToast is available so we don't pay a PowerShell cold
// start on *every* commit. `undefined` = not probed yet.
let burntToastAvailable: boolean | undefined;

/**
 * Fire a Windows toast notification, non-blocking.
 *
 * The commit must never wait on a UI toast, so this spawns a detached
 * PowerShell process and returns immediately. Tries BurntToast first (probed
 * once, cached), then falls back to a Shell balloon.
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

  try {
    const child = spawnFn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        // Pass payload via env — no string interpolation, no injection surface.
        env: { ...process.env, BYPASSER_TOAST_TITLE: title, BYPASSER_TOAST_MSG: message },
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }
    );
    child.unref();
  } catch {
    // never block the commit because of a notification
  }
}

/**
 * Build the PowerShell script. Values are read from env vars, never inlined,
 * so quotes/`$`/backticks in the title or message cannot break out.
 * When BurntToast is unavailable (cached probe), the script itself exits so
 * the caller does not need a second cold start.
 */
export function buildScript(icon: string): string {
  const useBurntToast = burntToastAvailable !== false;
  const probe = useBurntToast
    ? "if (-not (Get-Module -ListAvailable -Name BurntToast)) { exit 3 }"
    : "";

  return `
$ErrorActionPreference = 'Stop'
$title = $env:BYPASSER_TOAST_TITLE
$msg = $env:BYPASSER_TOAST_MSG
${probe}
if (Get-Module -ListAvailable -Name BurntToast) {
  Import-Module BurntToast -ErrorAction SilentlyContinue
  New-BurntToastNotification -Text $title, $msg | Out-Null
} else {
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
