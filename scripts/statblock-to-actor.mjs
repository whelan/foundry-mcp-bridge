#!/usr/bin/env node
// Converts the ```statblock fences in an Obsidian note into dnd5e Foundry actor
// JSON, offline, with the exact converter the importer uses
// (statblockToFoundryActor). Before this existed, a repo that needed an actor
// file on disk had a model write ~700 lines of actor JSON by hand per NPC,
// copying the shape of an existing actor; this produces the same document
// deterministically from the stat block that already exists.
//
// Every fence in the note is read (vault notes often carry several), each one
// is linted first, and a block with a lint FAIL is refused: a FAIL means an
// action would silently import as a non-rollable feat, and writing that to
// disk would hide the problem instead of surfacing it.
//
// PORTABLE like lint-statblock.mjs: `npm run bundle:write-statblock-skill`
// bundles this file too, into
// .claude/skills/write-statblock/statblock-to-actor.bundle.cjs, so a consumer
// repo runs it with bare node. Never hand-edit the bundle.
//
// Usage:
//   node statblock-to-actor.mjs note.md                  # all blocks -> stdout (JSON array)
//   node statblock-to-actor.mjs note.md --name "Vasha"   # one block -> stdout (JSON object)
//   node statblock-to-actor.mjs note.md --out dir/       # one <key>.json per block
//   node statblock-to-actor.mjs note.md --img path.webp  # portrait + token image
//
// Exit 1 on a missing block, a parse error or a lint FAIL; nothing is written
// for a note with any refused block.

import fs from "fs";
import path from "path";
import { parseStatblock, statblockToFoundryActor, lintStatblockNote, statblockKey } from "@foundry-mcp-bridge/statblock-sync";

const FENCE_RE = /^```statblock[^\n]*\n([\s\S]*?)\n```/gm;

function usage(msg) {
  if (msg) console.error(msg);
  console.error("Usage: statblock-to-actor <note.md> [--name <name>] [--out <dir>] [--img <path>]");
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) usage(`${flag} needs a value`);
  args.splice(i, 2);
  return v;
};
const name = opt("--name");
const outDir = opt("--out");
const img = opt("--img");
if (args.length !== 1) usage();
const file = args[0];

const markdown = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const blocks = [...markdown.matchAll(FENCE_RE)].map((m) => `\`\`\`statblock\n${m[1]}\n\`\`\`\n`);
if (!blocks.length) usage(`${file}: no \`\`\`statblock fence found`);

const actors = [];
const failures = [];
for (const block of blocks) {
  let sb;
  try {
    sb = parseStatblock(block);
  } catch (e) {
    const guess = /^name:\s*(.+)$/m.exec(block)?.[1] ?? "(unnamed)";
    if (!name || guess.trim() === name) failures.push(`${guess.trim()}: parse error: ${e.message}`);
    continue;
  }
  if (name && sb.data.name !== name) continue;
  const fails = lintStatblockNote(block).filter((f) => f.severity === "FAIL");
  if (fails.length) {
    for (const f of fails) failures.push(`${sb.data.name}: ${f.action}: ${f.problem}`);
    continue;
  }
  actors.push(statblockToFoundryActor(sb, img));
}

if (failures.length) {
  console.error(`${file}: refused, fix these first (the stat block lint names the same):`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
if (!actors.length) usage(`${file}: no block named "${name}"`);

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const a of actors) {
    const out = path.join(outDir, `${statblockKey(a.name)}.json`);
    fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
    console.log(`Wrote ${out}`);
  }
} else {
  process.stdout.write(JSON.stringify(name ? actors[0] : actors, null, 2) + "\n");
}
