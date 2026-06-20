#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, saveManifest } from "./manifest.js";
import { DEFAULT_TYPE_MAP } from "./notes.js";
import { scanRepo } from "./scan.js";
import { computePlan, planToTable } from "./planner.js";
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

const cmd = process.argv[2];
if (cmd === "plan") cmdPlan();
else if (cmd === "record") cmdRecord();
else {
  process.stderr.write("usage: foundry-sync <plan|record> --live <file> [--notes dir] [--manifest path] [--results file]\n");
  process.exit(1);
}
