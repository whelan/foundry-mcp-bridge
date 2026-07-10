#!/usr/bin/env node
// Lints an Obsidian Fantasy Statblocks note against the 2024-only grammar
// @foundry-mcp-bridge/statblock-sync actually accepts (see grammar.ts's
// module header and docs/statblock-import-execution-plan.md's M3 section:
// 2014 phrasing is deliberately unsupported and silently becomes a
// non-rollable feat).
//
// This is NOT a re-implementation of the grammar — it imports the exact same
// parseAttackAction/parseSaveAction/statblockToFoundryActor the real importer
// uses, so a note that lints clean is guaranteed to convert the same way,
// and this can never drift from the converter's actual behavior.
//
// PORTABLE: this is the source of truth, but it depends on the workspace
// package "@foundry-mcp-bridge/statblock-sync" and won't run standalone.
// `npm run bundle:write-statblock-skill` (see scripts/bundle-write-statblock-skill.mjs)
// bundles this file plus that dependency (and its zod/yaml/shared transitive
// deps) into a single dependency-free .claude/skills/write-statblock/lint-statblock.bundle.cjs
// — copy the whole write-statblock/ skill folder into any other repo (e.g. an
// Obsidian vault repo) and run `node lint-statblock.bundle.cjs` there, no npm
// install / monorepo required. Re-run the bundle command whenever this file
// or the grammar changes; never hand-edit the .cjs output. See that skill's
// SKILL.md.
//
// Usage:
//   node lint-statblock.mjs path/to/note.md [more.md ...] [a-folder/]
//   node lint-statblock.mjs                 # recursively lints every *.md
//                                            # under the current directory
//                                            # (skipping node_modules/.git/.obsidian)
//
// Exit code 1 if any FAIL survives; 0 if only warnings (or nothing to flag).

import fs from "fs";
import path from "path";
import { lintStatblockNote } from "@foundry-mcp-bridge/statblock-sync";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".obsidian", "dist"]);

/** Expand a file/dir argument into a flat list of .md file paths. */
function expand(p) {
  const stat = fs.statSync(p);
  if (stat.isFile()) return [p];
  return walk(p);
}

// A manual recursive walk instead of fs.globSync: globSync was only added in
// Node 22 (still experimental for several releases after), which would break
// this script on Node 20 -- exactly the "bare node, no monorepo" portability
// goal this file exists for.
function walk(dir) {
  const out = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(dirent.name)) continue;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...walk(full));
    } else if (dirent.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const files = (args.length > 0 ? args : ["."]).flatMap(expand);

if (files.length === 0) {
  console.error("No .md files found (searched: " + (args.length > 0 ? args.join(", ") : "current directory") + ").");
  process.exit(1);
}

let anyFail = false;
let anyWarn = false;
let checked = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, "utf-8");
  const findings = lintStatblockNote(raw);

  // Skip files with no issues
  if (findings.length === 0) continue;

  checked++;
  const name = path.basename(file);
  console.log(`\n${name}`);

  let hasFailures = false;
  for (const f of findings) {
    const label = f.severity === "FAIL" ? "FAIL" : "WARN";
    console.log(`  ${label}  ${f.action}: ${f.problem}`);
    if (f.severity === "FAIL") hasFailures = true;
  }

  if (hasFailures) anyFail = true;
  if (findings.some((f) => f.severity === "WARN")) anyWarn = true;
}

console.log("");
if (checked === 0) {
  console.log(`No \`\`\`statblock notes found among ${files.length} .md file(s) scanned.`);
}
if (anyFail) {
  console.log(`LINT FAILED (${checked} statblock note(s) checked) — one or more actions will not import with the mechanics they claim to have.`);
  process.exit(1);
}
console.log(anyWarn ? "LINT PASSED (with warnings)." : "LINT PASSED.");
