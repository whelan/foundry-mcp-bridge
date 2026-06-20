import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "./scan.js";
import { DEFAULT_TYPE_MAP } from "./notes.js";
import { computePlan } from "./planner.js";
import { emptyManifest, serializeManifest, parseManifest } from "./manifest.js";
import type { LiveState, Manifest } from "./types.js";

describe("round-trip: plan → record → re-plan", () => {
  it("a created doc becomes unchanged after recording the plan's contentHash", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-"));
    mkdirSync(join(dir, "generated/npcs"), { recursive: true });
    writeFileSync(join(dir, "generated/npcs/a.md"), "---\nname: A\n---\nbody\n");
    const world = { id: "w", system: "dnd5e", forge: false };

    // Plan 1: never imported → create. The plan item carries the contentHash.
    const plan1 = computePlan(emptyManifest(world), scanRepo(dir, DEFAULT_TYPE_MAP), {
      world: { id: "w" },
      docs: {},
    });
    const item = plan1.items[0]!;
    expect(item.action).toBe("create");
    expect(item.contentHash).toMatch(/^sha256:/);

    // Record: build the manifest entity by copying the plan's contentHash (no LLM hashing).
    const manifest: Manifest = emptyManifest(world);
    manifest.entities[item.source] = {
      documentType: item.documentType,
      foundryId: "F1",
      contentHash: item.contentHash,
      remoteModifiedTime: 100,
      lastImportedAt: "t",
      assets: [],
    };
    const reloaded = parseManifest(serializeManifest(manifest)); // survives disk round-trip

    // Plan 2: nothing changed on either side → unchanged.
    const live: LiveState = { world: { id: "w" }, docs: { F1: { foundryId: "F1", modifiedTime: 100 } } };
    const plan2 = computePlan(reloaded, scanRepo(dir, DEFAULT_TYPE_MAP), live);
    expect(plan2.items[0]?.action).toBe("unchanged");
  });
});
