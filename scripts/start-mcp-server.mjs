#!/usr/bin/env node
// Launcher used by .mcp.json. Builds the server when the build is missing OR
// stale (any TypeScript source or tsconfig newer than the built entry), then
// starts it. A stale dist silently runs old code -- e.g. a pre-peer-mode build
// that crashes with EADDRINUSE when two MCP servers share RELAY_URL -- so a
// `git pull` must never require remembering `npm run build`.
// All build output goes to stderr to avoid corrupting the stdio JSON-RPC
// stream the MCP client reads on stdout.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "packages/mcp-server/dist/index.js");
const lockDir = resolve(root, ".build.lock");
const log = (m) => process.stderr.write(`[foundry-mcp-bridge] ${m}\n`);

const mtime = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** Newest mtime of any .ts/.tsx source or tsconfig the server build depends on. */
function newestSource() {
  let newest = Math.max(mtime(join(root, "tsconfig.base.json")), mtime(join(root, "tsconfig.json")));
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (/\.tsx?$/.test(e.name) || e.name === "tsconfig.json" || e.name === "package.json") {
        newest = Math.max(newest, mtime(p));
      }
    }
  };
  const pkgs = join(root, "packages");
  for (const pkg of readdirSync(pkgs)) walk(join(pkgs, pkg));
  return newest;
}

const needsBuild = () => !existsSync(entry) || newestSource() > mtime(entry);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (needsBuild()) {
  // Several MCP servers (foundry, foundry-extra, other sessions) start at once;
  // only one may run tsc. The rest wait for its lock, then re-check.
  const deadline = Date.now() + 180_000;
  let haveLock = false;
  while (!haveLock && Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      haveLock = true;
    } catch {
      // A lock older than 3 minutes is a crashed build; take it over.
      if (Date.now() - mtime(lockDir) > 180_000) rmSync(lockDir, { recursive: true, force: true });
      else sleep(250);
    }
  }
  try {
    if (needsBuild()) {
      log(existsSync(entry) ? "source changed; rebuilding server..." : "building server (first run)...");
      const build = spawnSync("npm", ["run", "build"], {
        cwd: root,
        stdio: ["ignore", "ignore", "inherit"],
      });
      if (build.status !== 0) {
        log("build failed; run `npm install && npm run build`.");
        if (!existsSync(entry)) process.exit(1);
        log("starting the previous build instead.");
      } else {
        // tsc -b may skip rewriting an unchanged output; mark the build fresh
        // so the next start doesn't rebuild again.
        const now = new Date();
        utimesSync(entry, now, now);
      }
    }
  } finally {
    if (haveLock) rmSync(lockDir, { recursive: true, force: true });
  }
}

// Import via a file:// URL so the dynamic import is portable (Windows paths
// with backslashes / drive letters aren't valid import specifiers otherwise).
const { start } = await import(pathToFileURL(entry).href);
await start();
