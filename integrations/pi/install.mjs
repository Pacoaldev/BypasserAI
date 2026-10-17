#!/usr/bin/env node
//
// Installs the BypasserAI panel into Pi's user extensions directory.
//
// Pi auto-loads every file in <configDir>/extensions, so installing is a copy
// and there is no registration file to edit.
//
//   node integrations/pi/install.mjs             install
//   node integrations/pi/install.mjs --print     show the paths, write nothing
//   node integrations/pi/install.mjs --uninstall remove the installed copy

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "bypasser-panel.ts");

function configDir() {
  const override = process.env.PI_CODING_AGENT_DIR;
  return override && override.trim() !== "" ? resolve(override) : join(homedir(), ".pi", "agent");
}

const target = join(configDir(), "extensions", "bypasser-panel.ts");
const flags = new Set(process.argv.slice(2));

if (flags.has("--print")) {
  console.log(`copy ${source}\n  -> ${target}`);
  process.exit(0);
}

if (flags.has("--uninstall")) {
  if (!existsSync(target)) {
    console.log(`nothing installed at ${target}`);
    process.exit(0);
  }
  rmSync(target);
  console.log(`removed ${target}`);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`installed ${target}`);
console.log("Run /reload in Pi (or restart it) to load the panel.");