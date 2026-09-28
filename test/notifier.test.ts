import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notifyWindows,
  buildScript,
  _resetBurntToastCache,
  _setBurntToastAvailable,
} from "../src/notifier.js";

test("buildScript: values are read from env, never inlined", () => {
  const script = buildScript("Information");
  assert.match(script, /\$env:BYPASSER_TOAST_TITLE/);
  assert.match(script, /\$env:BYPASSER_TOAST_MSG/);
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

test("notifyWindows: spawns detached powershell and returns immediately", () => {
  _resetBurntToastCache();
  let capturedCmd = "";
  let capturedArgs: string[] = [];
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let unrefCalled = false;

  notifyWindows(
    { title: "BypasserAI", message: "2 files rewritten" },
    {
      platform: "win32",
      spawnFn: ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        capturedCmd = cmd;
        capturedArgs = args;
        capturedEnv = opts.env;
        return { unref: () => (unrefCalled = true) } as never;
      }) as never,
    }
  );

  assert.equal(capturedCmd, "powershell");
  assert.ok(capturedArgs.includes("-Command"));
  assert.equal(capturedEnv?.BYPASSER_TOAST_TITLE, "BypasserAI");
  assert.equal(capturedEnv?.BYPASSER_TOAST_MSG, "2 files rewritten");
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
