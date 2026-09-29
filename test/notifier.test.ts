import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notifyWindows,
  buildScript,
  buildLaunch,
  POWERSHELL_AUMID,
  _resetBurntToastCache,
  _setBurntToastAvailable,
} from "../src/notifier.js";

test("buildScript: values are read from env, never inlined", () => {
  const script = buildScript("Information");
  assert.match(script, /\$env:BYPASSER_TOAST_TITLE/);
  assert.match(script, /\$env:BYPASSER_TOAST_MSG/);
});

test("buildScript: uses the persistent WinRT toast under the PowerShell AUMID", () => {
  _resetBurntToastCache();
  const script = buildScript("Information");
  // The WinRT path is what makes the toast survive in the Action Center.
  assert.match(script, /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.match(script, /CreateToastNotifier\(/);
  // Registered AUMID — an arbitrary one is silently dropped by Windows.
  assert.match(script, /WindowsPowerShell/);
  assert.ok(script.includes(POWERSHELL_AUMID));
  // The deprecated balloon must remain only as a fallback inside catch.
  assert.match(script, /catch/);
});

test("buildScript: toast title/message are XML-escaped before embedding", () => {
  const script = buildScript("Information");
  assert.match(script, /SecurityElement\]::Escape/);
});

test("buildScript: BurntToast block is skipped once the probe failed", () => {
  _setBurntToastAvailable(false);
  const script = buildScript("Information");
  assert.doesNotMatch(script, /New-BurntToastNotification/);
  _resetBurntToastCache();
});

test("notifyWindows: no-op on non-Windows platforms", () => {
  let called = false;
  notifyWindows(
    { title: "t", message: "m" },
    {
      platform: "linux",
      spawnFn: (() => {
        called = true;
        return { unref() {} } as never;
      }) as never,
    }
  );
  assert.equal(called, false);
});

test("buildLaunch: uses cmd /c start so the toast survives the hook exiting", () => {
  const { cmd, args } = buildLaunch("Write-Output hi");
  // cmd /c start "" /b powershell ... — breaks out of the parent's job object,
  // which is required because the hook calls process.exit(0) immediately.
  assert.equal(cmd, "cmd");
  assert.deepEqual(args.slice(0, 4), ["/c", "start", "", "/b"]);
  assert.equal(args[4], "powershell");
  // EncodedCommand avoids every cmd.exe quoting/newline hazard.
  assert.ok(args.includes("-EncodedCommand"));
  const encoded = args[args.length - 1];
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.equal(decoded, "Write-Output hi");
});

test("notifyWindows: spawns the detached launcher and returns immediately", () => {
  _resetBurntToastCache();
  let capturedCmd = "";
  let capturedArgs: string[] = [];
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let capturedOpts: { detached?: boolean; stdio?: string } | undefined;
  let unrefCalled = false;

  notifyWindows(
    { title: "BypasserAI", message: "2 files rewritten" },
    {
      platform: "win32",
      spawnFn: ((
        cmd: string,
        args: string[],
        opts: { env: NodeJS.ProcessEnv; detached?: boolean; stdio?: string }
      ) => {
        capturedCmd = cmd;
        capturedArgs = args;
        capturedEnv = opts.env;
        capturedOpts = opts;
        return { unref: () => (unrefCalled = true) } as never;
      }) as never,
    }
  );

  assert.equal(capturedCmd, "cmd");
  assert.ok(capturedArgs.includes("-EncodedCommand"));
  assert.equal(capturedEnv?.BYPASSER_TOAST_TITLE, "BypasserAI");
  assert.equal(capturedEnv?.BYPASSER_TOAST_MSG, "2 files rewritten");
  assert.equal(capturedOpts?.detached, true, "must detach from the hook process");
  assert.equal(unrefCalled, true, "must unref so the commit is not blocked");
});

test("notifyWindows: quotes in title do not break out (passed via env)", () => {
  _setBurntToastAvailable(true);
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  notifyWindows(
    { title: "x'); rm -rf /; #", message: "$(evil) `tick`" },
    {
      platform: "win32",
      spawnFn: ((_c: string, _a: string[], opts: { env: NodeJS.ProcessEnv }) => {
        capturedEnv = opts.env;
        return { unref() {} } as never;
      }) as never,
    }
  );
  // raw values reach the process unchanged and are never concatenated into the script
  assert.equal(capturedEnv?.BYPASSER_TOAST_TITLE, "x'); rm -rf /; #");
  assert.equal(capturedEnv?.BYPASSER_TOAST_MSG, "$(evil) `tick`");
});
