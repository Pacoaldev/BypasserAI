import {
  existsSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  unlinkSync,
} from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";

const HOOK_MARKER = "# bypasser-ai";
// Git for Windows only executes a hook named exactly `pre-commit` (no
// extension) or `pre-commit.exe`. It *ignores* `pre-commit.cmd` / `.bat`
// entirely — a .cmd trampoline silently never runs, which is a trap we fell
// into once. So the hook is always the extensionless `pre-commit` file.
const HOOK_NAME = "pre-commit";
// Windows-only companion: a WSH script that launches the queued toast
// PowerShell script hidden. Launched through `wscript.exe` (a GUI-subsystem
// binary, so it can never allocate a console window).
const HOOK_VBS_NAME = "pre-commit-runner.vbs";
// Left behind by older bypasser-ai installs (the .cmd trampoline). Cleaned up
// on install/uninstall so it does not linger.
const LEGACY_CMD_NAME = "pre-commit.cmd";

/**
 * The extensionless `pre-commit` shell script.
 *
 * Why `#!/bin/sh` and not a `.cmd`: Git for Windows honours `pre-commit`
 * (extensionless) and `pre-commit.exe`, but ignores `pre-commit.cmd`/`.bat`.
 * A `#!/bin/sh` hook runs under Git's bundled `sh.exe`; measured on a
 * console-less parent it does not allocate a visible console window, and when
 * the parent already owns a console (a terminal) it simply inherits it.
 *
 * The audit runs in the foreground: its output is useful and the commit must
 * be gated on the rewrite result. Only the notification is deferred: it is
 * fired through `wscript` (GUI subsystem → no console, ever), which runs the
 * queued PowerShell script hidden. Node never spawns PowerShell itself.
 */
function buildHookScript(): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by bypasser-ai. Do not edit by hand; run \`bypasser uninstall\`.
#
# The audit runs in the foreground so its output is visible and the commit is
# gated on it. The toast is fired afterwards through \`wscript\` (a GUI-subsystem
# binary: it can never open a console window), which runs the PowerShell script
# the audit queued, hidden. That indirection is what keeps notifications
# working with zero terminal flash on the desktop.
hook_dir=$(cd "$(dirname "$0")" && pwd)

cli=""
for cand in \\
  "$hook_dir/../../../dist/cli.js" \\
  "$hook_dir/../../dist/cli.js" \\
  "$hook_dir/../dist/cli.js" \\
  "$hook_dir/dist/cli.js"
do
  if [ -f "$cand" ]; then cli="$cand"; break; fi
done

if [ -n "$cli" ]; then
  node "$cli" audit --pre-commit --verbose
else
  # Fall back to the globally installed binary on PATH (npm i -g bypasser-ai).
  bypasser audit --pre-commit --verbose
fi
status=$?

# Fire the toast the audit queued (if any), hidden and without blocking the
# commit. \`wscript //B\` runs in batch mode: no console, no dialogs.
if [ -f "$hook_dir/${HOOK_VBS_NAME}" ]; then
  wscript //nologo //B "$hook_dir/${HOOK_VBS_NAME}" >/dev/null 2>&1
fi

exit $status
`;
}

/**
 * Windows-only toast launcher (WSH/VBScript).
 *
 * It does no work of its own: if the audit queued a toast script under
 * `%TEMP%`, it runs it through `WScript.Shell.Run` at WindowStyle=0 (hidden)
 * and does not wait. `WScript.Shell.Run` is the Windows-native way to spawn a
 * process invisibly — it never allocates a console, unlike spawning
 * `cmd.exe`/`powershell.exe` from Node, which flickers a black window in the
 * middle of the desktop for a few hundred milliseconds.
 */
function buildVbsRunner(): string {
  return `' ${HOOK_MARKER}
Option Explicit
Dim shell, fso, tmpDir, psFile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
tmpDir = shell.ExpandEnvironmentStrings("%TEMP%")
psFile = fso.BuildPath(tmpDir, "bypasser-ai-toast.ps1")
If fso.FileExists(psFile) Then
    shell.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & psFile & """", 0, False
End If
WScript.Quit 0
`;
}

export function install(cwd = process.cwd()): void {
  const hookDir = resolve(cwd, ".git", "hooks");
  if (!existsSync(hookDir)) {
    throw new Error(
      "No .git/hooks directory found. Is this a git repository?"
    );
  }

  const hookPath = resolve(hookDir, HOOK_NAME);
  const vbsPath = resolve(hookDir, HOOK_VBS_NAME);
  const legacyCmdPath = resolve(hookDir, LEGACY_CMD_NAME);

  // Detect an existing bypasser install — either marker survives.
  const existingHook = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";
  const existingVbs = existsSync(vbsPath) ? readFileSync(vbsPath, "utf8") : "";
  const alreadyInstalled =
    existingHook.includes(HOOK_MARKER) || existingVbs.includes(HOOK_MARKER);

  if (alreadyInstalled) {
    // Refresh the payload in case this is a reinstall after an upgrade, and
    // sweep any stale .cmd trampoline from an older version.
    writeFileSync(hookPath, buildHookScript(), "utf8");
    if (process.platform === "win32") writeFileSync(vbsPath, buildVbsRunner(), "utf8");
    removeIfBypasserOwned(legacyCmdPath);
    console.log("bypasser-ai pre-commit hook already installed.");
    return;
  }

  // If a non-bypasser hook already exists at the primary path, we cannot
  // safely overwrite it. Surface that to the user instead of silently
  // breaking their workflow.
  if (existsSync(hookPath)) {
    throw new Error(
      `Cannot install bypasser-ai hook: ${HOOK_NAME} already exists and was not created by bypasser-ai. ` +
        `Please remove it or merge the bypasser-ai invocation manually.`
    );
  }

  writeFileSync(hookPath, buildHookScript(), "utf8");
  if (process.platform === "win32") writeFileSync(vbsPath, buildVbsRunner(), "utf8");
  removeIfBypasserOwned(legacyCmdPath);
  console.log(
    `bypasser-ai pre-commit hook installed (${HOOK_NAME}${process.platform === "win32" ? " + " + HOOK_VBS_NAME : ""}).`
  );

  // make executable (no-op on Windows but harmless)
  try {
    chmodSync(hookPath, 0o755);
    if (process.platform === "win32") chmodSync(vbsPath, 0o755);
  } catch {
    // windows — skip
  }

  // Register our AppUserModelID so Windows renders the toast as a normal
  // app notification rather than silently filtering it. No-op on non-Windows
  // platforms.
  if (process.platform === "win32") {
    try {
      registerAumid();
      console.log("bypasser-ai registered as 'BypasserAI' notification app.");
    } catch (err) {
      console.warn(
        "bypasser-ai: could not register AUMID (" + (err instanceof Error ? err.message : String(err)) + "). " +
          "Toasts may be silently dropped by Windows; see docs/notifications.md."
      );
    }
  }
}

/**
 * Register the BypasserAI AppUserModelID under HKCU so the WinRT toast
 * pipeline accepts our toasts. Uses the current user's hive (no admin
 * needed). Idempotent — safe to call on every `bypasser install`.
 *
 * Why this exists: Windows 11 silently filters toasts whose AUMID resolves
 * to powershell.exe + -EncodedCommand (the per-AUMID counter still ticks
 * but the toast never visually surfaces). Registering our own AUMID, plus
 * the `ShellStructured=Toast` capability that the Action Center recognises,
 * lets the notification render as a normal app notification.
 */
function registerAumid(): void {
  const script = `
$ErrorActionPreference = 'Stop'
$aumid = 'BypasserAI.Notifier'
$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $aumid
if (-not (Test-Path $key)) {
  New-Item -Path $key -Force | Out-Null
}
Set-ItemProperty -Path $key -Name 'DisplayName' -Value 'BypasserAI' -Force
Set-ItemProperty -Path $key -Name 'ShowInSettings' -Value 1 -Force
$cap = $key + '\\Capabilities'
if (-not (Test-Path $cap)) {
  New-Item -Path $cap -Force | Out-Null
}
Set-ItemProperty -Path $cap -Name 'ShellStructured' -Value 'Toast' -Force
`.trim();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encoded,
    ],
    { stdio: "ignore", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error("powershell exited with status " + result.status);
  }
}

export function uninstall(cwd = process.cwd()): void {
  const hookDir = resolve(cwd, ".git", "hooks");
  const hookPath = resolve(hookDir, HOOK_NAME);
  const vbsPath = resolve(hookDir, HOOK_VBS_NAME);
  const legacyCmdPath = resolve(hookDir, LEGACY_CMD_NAME);

  let removedAnything = false;

  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, "utf8");
    if (content.includes(HOOK_MARKER)) {
      // Our hook is entirely ours — remove the whole file.
      unlinkSync(hookPath);
      removedAnything = true;
    } else {
      // A hook that merely *contains* our block (someone merged us into their
      // own hook) — strip just the bypasser block.
      const cleaned = stripBypasserBlock(content);
      writeFileSync(hookPath, cleaned, "utf8");
      removedAnything = true;
    }
  }

  if (existsSync(vbsPath) && readFileSync(vbsPath, "utf8").includes(HOOK_MARKER)) {
    unlinkSync(vbsPath);
    removedAnything = true;
  }

  if (removeIfBypasserOwned(legacyCmdPath)) removedAnything = true;

  if (!removedAnything) {
    console.log("No bypasser-ai pre-commit hook found.");
    return;
  }
  console.log("bypasser-ai pre-commit hook removed.");
}

/** Delete a file only if it carries our marker. Returns true if removed. */
function removeIfBypasserOwned(path: string): boolean {
  if (!existsSync(path)) return false;
  if (!readFileSync(path, "utf8").includes(HOOK_MARKER)) return false;
  unlinkSync(path);
  return true;
}

function stripBypasserBlock(content: string): string {
  return content
    .split("\n")
    .reduce<{ result: string[]; skip: boolean }>(
      (acc, line) => {
        if (line.includes(HOOK_MARKER)) return { result: acc.result, skip: true };
        if (acc.skip && line.trim() === "") return { result: acc.result, skip: false };
        if (!acc.skip) acc.result.push(line);
        return acc;
      },
      { result: [], skip: false }
    )
    .result.join("\n")
    .trimEnd();
}
