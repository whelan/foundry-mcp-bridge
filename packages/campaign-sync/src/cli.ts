#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { loadManifest, saveManifest } from "./manifest.js";
import { DEFAULT_TYPE_MAP } from "./notes.js";
import { scanRepo } from "./scan.js";
import { computePlan, planToTable } from "./planner.js";
import { readWorld } from "./leveldb.js";
import { buildVault } from "./world-export.js";
import type { LiveState, Manifest } from "./types.js";

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
 * export: read a downloaded Foundry world folder (LevelDB) and write campaign-sync
 * markdown notes + a foundry-sync.json manifest into an Obsidian vault.
 */
async function cmdExport(): Promise<void> {
  const worldDir = resolve(arg("world"));
  const outDir = resolve(arg("out"));
  const manifestPath = resolve(arg("manifest", join(outDir, "foundry-sync.json")));
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

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "plan") cmdPlan();
  else if (cmd === "record") cmdRecord();
  else if (cmd === "export") await cmdExport();
  else {
    process.stderr.write(
      "usage: foundry-sync <plan|record|export>\n" +
        "  plan   --live <file> [--notes dir] [--manifest path]\n" +
        "  record --results <file> --live <file> [--manifest path]\n" +
        "  export --world <foundry-world-dir> --out <vault-dir> [--manifest path]\n",
    );
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(1);
});
