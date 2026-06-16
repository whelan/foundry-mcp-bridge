#!/usr/bin/env node
// Installs the Foundry module into your Foundry data dir by symlinking
// packages/foundry-module -> <dataDir>/modules/foundry-mcp-bridge.
//
// Usage:
//   node scripts/install-into-foundry.mjs [FOUNDRY_DATA_DIR]
//   FOUNDRY_DATA=/path/to/FoundryVTT/Data node scripts/install-into-foundry.mjs
//
// If no path is given it tries the common per-OS locations. Safe to re-run.

import { existsSync, mkdirSync, lstatSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "foundry-module");

if (!existsSync(join(source, "module.json")) || !existsSync(join(source, "dist", "index.js"))) {
  console.error("Module not built. Run `npm run bundle:module` first.");
  process.exit(1);
}

function candidateDataDirs() {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [join(home, "Library", "Application Support", "FoundryVTT", "Data")];
    case "win32":
      return [join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "FoundryVTT", "Data")];
    default:
      return [
        join(home, ".local", "share", "FoundryVTT", "Data"),
        join(home, "FoundryVTT", "Data"),
      ];
  }
}

const explicit = process.argv[2] ?? process.env.FOUNDRY_DATA;
const dataDir = explicit ?? candidateDataDirs().find((d) => existsSync(d));

if (!dataDir) {
  console.error(
    "Could not find your Foundry data dir. Pass it explicitly:\n" +
      "  node scripts/install-into-foundry.mjs /path/to/FoundryVTT/Data\n" +
      "(the folder that contains `modules/`, `worlds/`, `systems/`).",
  );
  process.exit(1);
}

const modulesDir = join(dataDir, "modules");
mkdirSync(modulesDir, { recursive: true });
const target = join(modulesDir, "foundry-mcp-bridge");

if (existsSync(target) || isSymlink(target)) {
  rmSync(target, { recursive: true, force: true });
}

try {
  symlinkSync(source, target, "junction");
  console.log(`Symlinked module: ${target} -> ${source}`);
} catch (e) {
  // Fall back to a copy (e.g. Windows without symlink permission).
  cpSync(source, target, { recursive: true });
  console.log(`Copied module to: ${target} (symlink unavailable: ${(e).message})`);
}

console.log(
  "\nDone. In Foundry: load your test world as GM, enable \"Foundry MCP Bridge\"\n" +
    "in Manage Modules, then reload. With the local defaults it connects to\n" +
    "ws://localhost:8787 automatically — no settings to type.",
);

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
