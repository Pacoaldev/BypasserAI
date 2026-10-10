import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationCommand, notify, shouldNotify } from "../src/notifier.js";
import { loadConfig } from "../src/config.js";

test("notificationCommand: macOS uses osascript display notification", () => {
  const c = notificationCommand("darwin", "Title", "Message");
  assert.ok(c, "command should be generated");
  assert.equal(c!.cmd, "osascript");
  assert.ok(c!.args.join(" ").includes("display notification"));
  assert.ok(c!.args.join(" ").includes("Title"));
});

test("notificationCommand: escapes quotes/backslashes AppleScript", () => {
  const c = notificationCommand("darwin", 'a"b', "c\\d");
  assert.ok(c, "command should be generated");
  const script = c!.args.join(" ");
  assert.ok(script.includes('a\\"b'), "double quotes must be escaped");
  assert.ok(script.includes("c\\\\d"), "backslashes must be escaped");
});
// TODO: extract duplicate command checks

test("notificationCommand: Linux uses notify-send title+message", () => {
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
  let capturedArgs: unknown[] | null = null;
  const spawnFn = ((cmd: string, args: string[], opts: unknown) => {
    capturedArgs = [cmd, args, opts];
    return { unref() {} } as never;
  }) as never;
  notify({ title: "T", message: "M", mode: "auto" }, { platform: "linux", spawnFn });
  assert.ok(capturedArgs, "spawn should have been called");
  assert.equal(capturedArgs![0], "notify-send");
  assert.deepEqual(capturedArgs![1], ["T", "M"]);
});
 
test("notify: never throws even if spawn throws", () => {
  const spawnFn = (() => {
    throw new Error("no such binary");
  }) as never;
  // Notification failure must never block a commit.
  notify({ title: "T", message: "M", mode: "auto" }, { platform: "linux", spawnFn });
});
 
test("config: notifications defaults to auto and accepts off (file + env)", () => {
  // Hermetic: no .bypasser.json here, so we assert built‑in default.
  const dir = mkdtempSync(join(tmpdir(), "bypasser-notif-"));
  const prev = process.env.BYPASSER_NOTIFICATIONS;
  try {
    delete process.env.BYPASSER_NOTIFICATIONS;
    assert.equal(loadConfig(dir).notifications, "auto", "default is auto");
 
    writeFileSync(
      join(dir, ".bypasser.json"),
      JSON.stringify({ notifications: "off" }),
      "utf8"
    );
    assert.equal(loadConfig(dir).notifications, "off", "file off is honoured");
 
    process.env.BYPASSER_NOTIFICATIONS = "auto";
    assert.equal(loadConfig(dir).notifications, "auto", "env wins over file");
  } finally {
    if (prev === undefined) delete process.env.BYPASSER_NOTIFICATIONS;
    else process.env.BYPASSER_NOTIFICATIONS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
 
// --- `important` mode: only humanized + error are actionable -------------
 
test("shouldNotify: off never notifies", () => {
  for (const ev of ["humanized", "error", "rejected", "clean"] as const) {
    assert.equal(shouldNotify("off", ev), false, `off/${ev}`);
  }
});
 
test("shouldNotify: auto notifies every event", () => {
  for (const ev of ["humanized", "error", "rejected", "clean"] as const) {
    assert.equal(shouldNotify("auto", ev), true, `auto/${ev}`);
  }
});
 
test("shouldNotify: important notifies humanized and error only", () => {
  assert.equal(shouldNotify("important", "humanized"), true);
  assert.equal(shouldNotify("important", "error"), true);
  assert.equal(shouldNotify("important", "rejected"), false);
  assert.equal(shouldNotify("important", "clean"), false);
});
 
test("shouldNotify: missing mode defaults to auto; missing event to humanized", () => {
  assert.equal(shouldNotify(undefined, undefined), true);
  assert.equal(shouldNotify("important", undefined), true, "defaults to humanized");
});
 
test("notify: important spawns on Humanized but stays silent on Clean", () => {
  let spawns = 0;
  const spawnFn = (() => {
    spawns++;
    return { unref() {} } as never;
  }) as never;
 
  notify(
    { title: "t", message: "m", mode: "important", event: "humanized" },
    { platform: "linux", spawnFn }
  );
  assert.equal(spawns, 1, "humanized must notify");
 
  notify(
    { title: "t", message: "m", mode: "important", event: "clean" },
    { platform: "linux", spawnFn }
  );
  assert.equal(spawns, 1, "clean must NOT notify under important");
 
  notify(
    { title: "t", message: "m", mode: "important", event: "rejected" },
    { platform: "linux", spawnFn }
  );
  assert.equal(spawns, 1, "rejected must NOT notify under important");
 
  notify(
    { title: "t", message: "m", mode: "important", event: "error" },
    { platform: "linux", spawnFn }
  );
  assert.equal(spawns, 2, "error must notify under important");
});
 
test("config: accepts notifications=important (file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bypasser-notif-"));
  try {
    writeFileSync(
      join(dir, ".bypasser.json"),
      JSON.stringify({ notifications: "important" }),
      "utf8"
    );
    assert.equal(loadConfig(dir).notifications, "important");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
 
test("config: BYPASSER_NOTIFICATIONS=important wins over the file", () => {
  const prev = process.env.BYPASSER_NOTIFICATIONS;
  const dir = mkdtempSync(join(tmpdir(), "bypasser-notif-"));
  try {
    writeFileSync(
      join(dir, ".bypasser.json"),
      JSON.stringify({ notifications: "off" }),
      "utf8"
    );
    process.env.BYPASSER_NOTIFICATIONS = "important";
    assert.equal(loadConfig(dir).notifications, "important");
  } finally {
    if (prev === undefined) delete process.env.BYPASSER_NOTIFICATIONS;
    else process.env.BYPASSER_NOTIFICATIONS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});