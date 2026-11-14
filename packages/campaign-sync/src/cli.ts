#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { loadManifest, saveManifest } from "./manifest.js";
import { DEFAULT_TYPE_MAP } from "./notes.js";
import { scanRepo } from "./scan.js";
import { computePlan, planToTable } from "./planner.js";
import { readWorld } from "./leveldb.js";
import { buildVault } from "./world-export.js";
import { renderPlan } from "./render.js";
import type { LiveState, Manifest, Plan } from "./types.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function cmdPlan(): void {
  const root = arg("notes", process.cwd());
  const manifestPath = resolve(arg("manifest", "foundry-sync.json"));
  const live = readJson<LiveState>(arg("live"));
  const manifest = loadManifest(manifestPath, { id: live.world.id, system: arg("system", "dnd5e"), forge: arg("forge", "true") === "true" });
  const plan = computePlan(manifest, scanRepo(root, DEFAULT_TYPE_MAP), live);
  process.stderr.write(planToTable(plan) + "\n");
  process.stdout.write(JSON.stringify(plan, null, 2));
}

function cmdRecord(): void {
  const manifestPath = resolve(arg("manifest", "foundry-sync.json"));
  // results.json: a partial Manifest["entities"] map produced by the skill after writes.
  const updates = readJson<Manifest["entities"]>(arg("results"));
  const live = readJson<LiveState>(arg("live"));
  const manifest = loadManifest(manifestPath, { id: live.world.id, system: arg("system", "dnd5e"), forge: arg("forge", "true") === "true" });
  manifest.entities = { ...manifest.entities, ...updates };
  saveManifest(manifestPath, manifest);
  process.stderr.write(`recorded ${Object.keys(updates).length} entities → ${manifestPath}\n`);
}

/**
 * render: turn a plan's create/update JournalEntry items into write-ready page
 * payloads (Markdown body → HTML `text.content`, format 1). The importing skill
 * passes these straight to the bridge instead of reading bodies into context and
 * converting by hand. Writes JSON to --out, or stdout when omitted.
 */
function cmdRender(): void {
  const root = resolve(arg("notes", process.cwd()));
  const plan = readJson<Plan>(arg("plan"));
  const docs = renderPlan(plan, (source) => readFileSync(resolve(root, source), "utf8"));
  const json = JSON.stringify(docs, null, 2);
  const outIdx = process.argv.indexOf("--out");
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    const outPath = resolve(process.argv[outIdx + 1]!);
    writeFileSync(outPath, json);
    process.stderr.write(`rendered ${docs.length} journal(s) → ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

/**
 * export: read a downloaded Foundry world folder (LevelDB) and write campaign-sync
 * markdown notes + a foundry-sync.json manifest into an Obsidian vault.
 */
async function cmdExport(): Promise<void> {
  const worldDir = resolve(arg("world"));
  const outDir = resolve(arg("out"));
  const manifestPath = resolve(arg("manifest", join(outDir, "foundry-sync.json")));
  // Stale-note guard: a re-export into an existing vault must not leave obsolete
  // generated/* notes behind (they'd plan as spurious creates). Refuse unless
  // --force, which first clears the four exporter-owned directories.
  const force = process.argv.includes("--force");
  const managedDirs = DEFAULT_TYPE_MAP.map((m) => m.prefix.replace(/\/$/, ""));
  const dirty = managedDirs.filter((d) => containsMarkdown(join(outDir, d)));
  if (dirty.length && !force) {
    throw new Error(
      `vault already has exported notes in ${dirty.join(", ")} — re-run with --force to replace ` +
        "the generated/* notes (otherwise stale files plan as spurious creates).",
    );
  }
  if (force) {
    for (const d of managedDirs) rmSync(join(outDir, d), { recursive: true, force: true });
  }

  const dump = await readWorld(worldDir);
  const { files, manifest } = buildVault(dump);
  for (const f of files) {
    const full = join(outDir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }
  // Ensure the manifest's directory exists even when no notes were written (or
  // --manifest points elsewhere) — otherwise saveManifest would ENOENT.
  mkdirSync(dirname(manifestPath), { recursive: true });
  saveManifest(manifestPath, manifest);
  process.stderr.write(
    `exported ${files.length} notes + manifest → ${outDir} (world ${manifest.world.id})\n`,
  );
}

/** True when `dir` (recursively) holds any markdown note. */
function containsMarkdown(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (containsMarkdown(join(dir, entry.name))) return true;
    } else if (entry.name.endsWith(".md")) {
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "plan") cmdPlan();
  else if (cmd === "record") cmdRecord();
  else if (cmd === "render") cmdRender();
  else if (cmd === "export") await cmdExport();
  else {
    process.stderr.write(
      "usage: foundry-sync <plan|record|render|export>\n" +
        "  plan   --live <file> [--notes dir] [--manifest path]\n" +
        "  record --results <file> --live <file> [--manifest path]\n" +
        "  render --plan <file> [--notes dir] [--out file]\n" +
        "  export --world <foundry-world-dir> --out <vault-dir> [--manifest path] [--force]\n",
    );
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
