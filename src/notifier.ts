import { execSync } from "child_process";

export interface NotifyOptions {
  title: string;
  message: string;
  /** "info" | "warning" | "error" — maps to toast icon */
  type?: "info" | "warning" | "error";
}

/**
 * Fire a Windows toast notification.
 *
 * Strategy:
 * 1. Try BurntToast (PowerShell module) — rich toast with icon
 * 2. Fall back to a simple balloon via Win32 Shell COM object — no extra deps
 * 3. If both fail, silently do nothing — never block the commit
 */
export function notifyWindows(opts: NotifyOptions): void {
  const { title, message, type = "info" } = opts;

  // sanitize: remove single quotes to avoid PS injection
  const safeTitle = title.replace(/'/g, "");
  const safeMsg = message.replace(/'/g, "");

  // BurntToast icon mapping
  const btIcon = type === "error" ? "Error" : type === "warning" ? "Warning" : "Information";

  const burntToast = `
    if (Get-Module -ListAvailable -Name BurntToast) {
      Import-Module BurntToast -ErrorAction SilentlyContinue
      New-BurntToastNotification -Text '${safeTitle}', '${safeMsg}' -AppLogo $null
    } else { exit 1 }
  `.trim();

  // Fallback: balloon notification via Shell COM (works on all Windows without extra modules)
  const balloon = `
    Add-Type -AssemblyName System.Windows.Forms
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::${btIcon}
    $n.BalloonTipTitle = '${safeTitle}'
    $n.BalloonTipText = '${safeMsg}'
    $n.BalloonTipIcon = '${btIcon}'
    $n.Visible = $true
    $n.ShowBalloonTip(6000)
    Start-Sleep -Milliseconds 6500
    $n.Dispose()
  `.trim();

  try {
    execSync(`powershell -NoProfile -NonInteractive -Command "${burntToast}"`, {
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    // BurntToast not available or failed — try balloon fallback
    try {
      execSync(`powershell -NoProfile -NonInteractive -Command "${balloon}"`, {
        timeout: 8000,
        stdio: "ignore",
      });
    } catch {
      // both failed — silent, never block the commit
    }
  }
}
