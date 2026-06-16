#!/usr/bin/env node
// Launcher used by .mcp.json. Builds the server on first run if needed (so a
// fresh checkout "just works"), then starts it. All build output goes to stderr
// to avoid corrupting the stdio JSON-RPC stream the MCP client reads on stdout.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "packages/mcp-server/dist/index.js");

if (!existsSync(entry)) {
  process.stderr.write("[foundry-mcp-bridge] building server (first run)...\n");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (build.status !== 0) {
    process.stderr.write("[foundry-mcp-bridge] build failed; run `npm install && npm run build`.\n");
    process.exit(1);
  }
}

// Import via a file:// URL so the dynamic import is portable (Windows paths
// with backslashes / drive letters aren't valid import specifiers otherwise).
const { start } = await import(pathToFileURL(entry).href);
await start();
