#!/usr/bin/env node
// Bundles scripts/lint-statblock.mjs plus its @foundry-mcp-bridge/statblock-sync
// dependency (and the transitive @foundry-mcp-bridge/shared randomID helper,
// zod, and yaml) into a single dependency-free .mjs, written into
// .claude/skills/write-statblock/. That makes the whole
// .claude/skills/write-statblock/ folder copy-paste portable into any other
// repo (e.g. an Obsidian vault repo) -- no npm install, no monorepo workspace
// resolution, just `node lint-statblock.bundle.mjs`.
//
// Run via `npm run bundle:write-statblock-skill` (this builds the workspace
// first so esbuild resolves the real compiled .js, not stale dist output).
// Re-run whenever packages/statblock-sync's grammar/schema changes -- don't
// hand-edit the bundle.

import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outfile = path.join(root, ".claude/skills/write-statblock/lint-statblock.bundle.cjs");

// CommonJS, not ESM: yaml's dependency tree has CJS modules that call
// require() for node builtins (e.g. "process") at load time. In a real .cjs
// file that's a normal, working require(). In ESM output there's no ambient
// `require`, so esbuild's require-shim throws "Dynamic require of ... is not
// supported" the moment such a module loads. A .cjs file also sidesteps the
// package.json "type": "module" (or lack of one) in whatever repo this gets
// copied into -- the extension alone decides how node loads it.
await build({
  entryPoints: [path.join(root, "scripts/lint-statblock.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
});

console.log(`Bundled -> ${path.relative(root, outfile)}`);
