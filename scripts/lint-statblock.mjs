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
import {
  parseStatblock,
  parseStatblockRaw,
  parseAttackAction,
  parseSaveAction,
  statblockToFoundryActor,
  KNOWN_DAMAGE_TYPES,
} from "@foundry-mcp-bridge/statblock-sync";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".obsidian", "dist"]);

/** Expand a file/dir argument into a flat list of .md file paths. */
function expand(p) {
  const stat = fs.statSync(p);
  if (stat.isFile()) return [p];
  return fs.globSync("**/*.md", {
    cwd: p,
    exclude: (name) => EXCLUDED_DIRS.has(name),
  }).map((f) => path.join(p, f));
}

const args = process.argv.slice(2);
const files = (args.length > 0 ? args : ["."]).flatMap(expand);

if (files.length === 0) {
  console.error("No .md files found (searched: " + (args.length > 0 ? args.join(", ") : "current directory") + ").");
  process.exit(1);
}

// Text that signals "this action is trying to be a roll" — if present but
// the corresponding parseX() came back undefined, the action is either
// 2014-style ("Melee Weapon Attack: +N to hit", "...DC N Ability saving
// throw...") or a malformed 2024 header, and will silently import as a
// plain, non-rollable feat instead.
const LOOKS_LIKE_ATTACK = /\b(?:attack roll|weapon attack|spell attack)\b/i;
const LOOKS_LIKE_SAVE = /\bsaving throw\b/i;

let anyFail = false;
let anyWarn = false;
let checked = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, "utf-8");

  // A vault has far more plain notes than statblocks — silently skip any
  // file with no ```statblock fence at all rather than reporting every
  // ordinary note as a failure. A file WITH a fence that's still invalid
  // (missing required fields, bad YAML) is a real, reportable failure below.
  const { data: rawData } = parseStatblockRaw(raw);
  if (Object.keys(rawData).length === 0) continue;

  checked++;
  const name = path.basename(file);
  console.log(`\n${name}`);

  let statblock;
  try {
    statblock = parseStatblock(raw);
  } catch (e) {
    // zod throws a ZodError whose .message is a JSON dump of every issue;
    // summarize as "field: problem" instead of printing that verbatim.
    const detail = Array.isArray(e.issues)
      ? e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join(", ")
      : e.message;
    console.log(`  FAIL  no valid \`statblock\` fence found or required fields missing -- ${detail}`);
    anyFail = true;
    continue;
  }

  const checks = [];

  // --- Action-text grammar: the actual point of this lint -----------------
  for (const action of statblock.actions) {
    const attack = parseAttackAction(action.description);
    const save = parseSaveAction(action.description);
    const looksAttack = LOOKS_LIKE_ATTACK.test(action.description);
    const looksSave = LOOKS_LIKE_SAVE.test(action.description);

    if (looksAttack && !attack) {
      checks.push({
        ok: false,
        msg: `"${action.name}" mentions an attack roll but doesn't match the 2024 header ` +
          `("Melee/Ranged Attack Roll: +N") -- will import as a non-rollable feat. ` +
          `2014 phrasing ("Melee Weapon Attack: +N to hit") is not supported.`,
      });
    }
    if (looksSave && !save) {
      checks.push({
        ok: false,
        msg: `"${action.name}" mentions a saving throw but doesn't match the 2024 header ` +
          `("<Ability> Saving Throw: DC N") -- will import as a non-rollable feat. ` +
          `2014 prose ("...DC N <Ability> saving throw...") is not supported.`,
      });
    }
    if (!attack && !save && !looksAttack && !looksSave) {
      checks.push({ ok: true, msg: `"${action.name}" — descriptive (no roll), as intended` });
    } else if (attack) {
      checks.push({ ok: true, msg: `"${action.name}" — attack, +${attack.bonus}` });
    } else if (save) {
      checks.push({ ok: true, msg: `"${action.name}" — save, DC ${save.dc} ${save.ability}` });
    }
  }

  // --- Trait lists: unrecognized damage-type tokens (typos, or a type that
  // didn't survive the Oxford-comma/qualifier-clause split as expected) -----
  const traitFields = [
    ["damage_resistances", statblock.traits.damageResistances],
    ["damage_immunities", statblock.traits.damageImmunities],
    ["damage_vulnerabilities", statblock.traits.damageVulnerabilities],
  ];
  for (const [field, values] of traitFields) {
    for (const v of values) {
      const known = KNOWN_DAMAGE_TYPES.has(v.trim().toLowerCase());
      const isQualifiedClause = /\bnonmagical\b|\bnon-magical\b|\bsilvered\b|\badamantine\b/i.test(v);
      if (!known && !isQualifiedClause) {
        checks.push({
          ok: "warn",
          msg: `${field}: "${v}" isn't a recognized damage type and isn't a qualified clause ` +
            `(e.g. "...from nonmagical attacks") -- will land in free-text custom, not the mechanical list.`,
        });
      }
    }
  }

  // --- CR: must resolve to a real XP entry, not silently fall through to 0 -
  if (statblock.challenge.xp === 0 && statblock.challenge.cr !== 0) {
    checks.push({
      ok: false,
      msg: `cr: ${statblock.data.cr} did not resolve to a known XP value (got 0) -- check the CR format.`,
    });
  }

  // --- Final sanity: the whole thing must actually convert without throwing
  try {
    statblockToFoundryActor(statblock);
  } catch (e) {
    checks.push({ ok: false, msg: `statblockToFoundryActor threw: ${e.message}` });
  }

  for (const c of checks) {
    const label = c.ok === true ? "PASS" : c.ok === "warn" ? "WARN" : "FAIL";
    console.log(`  ${label}  ${c.msg}`);
    if (c.ok === false) anyFail = true;
    if (c.ok === "warn") anyWarn = true;
  }
  if (checks.length === 0) {
    console.log("  (no actions/traits to check)");
  }
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
