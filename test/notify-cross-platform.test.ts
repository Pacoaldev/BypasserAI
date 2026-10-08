import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationCommand, notify } from "../src/notifier.js";
import { loadConfig } from "../src/config.js";

test("notificationCommand: macOS uses osascript display notification", () => {
  const c = notificationCommand("darwin", "Title", "Message");
  assert.ok(c);
  assert.equal(c!.cmd, "osascript");
  assert.ok(c!.args.join(" ").includes("display notification"));
  assert.ok(c!.args.join(" ").includes("Title"));
});

test("notificationCommand: escapes quotes/backslashes for AppleScript", () => {
  const c = notificationCommand("darwin", 'a"b', "c\\d");
  assert.ok(c);
  const script = c!.args.join(" ");
  assert.ok(script.includes('a\\"b'), "double quotes must be escaped");
  assert.ok(script.includes("c\\\\d"), "backslashes must be escaped");
});

test("notificationCommand: Linux uses notify-send with title+message", () => {
  const c = notificationCommand("linux", "T", "M");
  assert.deepEqual(c, { cmd: "notify-send", args: ["T", "M"] });
});

test("notificationCommand: Windows is handled elsewhere (returns null)", () => {
  assert.equal(notificationCommand("win32", "T", "M"), null);
});

test("notify: mode 'off' does nothing on any platform", () => {
  let called = false;
  const spawnFn = (() => {
    called = true;
    return { unref() {} } as never;
  }) as never;
  notify({ title: "t", message: "m", mode: "off" }, { platform: "linux", spawnFn });
  assert.equal(called, false, "off mode must not spawn anything");
});

test("notify: Linux spawns notify-send detached", () => {
  let spawnArgs: unknown[] | null = null;
  const spawnFn = ((cmd: string, args: string[], opts: unknown) => {
    spawnArgs = [cmd, args, opts];
    return { unref() {} } as never;
  }) as never;
  notify({ title: "T", message: "M", mode: "auto" }, { platform: "linux", spawnFn });
  assert.ok(spawnArgs, "spawn should have been called");
  assert.equal(spawnArgs![0], "notify-send");
  assert.deepEqual(spawnArgs![1], ["T", "M"]);
});

test("notify: never throws even if spawn throws", () => {
  const spawnFn = (() => {
    throw new Error("no such binary");
  }) as never;
  // Must not throw — a notification failure must never block a commit.
  notify({ title: "T", message: "M", mode: "auto" }, { platform: "linux", spawnFn });
});

test("config: notifications defaults to auto and accepts off (file + env)", () => {
  assert.equal(loadConfig(process.cwd()).notifications, "auto");
});
