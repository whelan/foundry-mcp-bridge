/**
 * Proves the Tier 1 compendium-match path is actually wired end-to-end: a
 * parsed statblock whose name exactly matches an SRD compendium fixture gets
 * imported via search_compendium + import_from_compendium (a real clone,
 * embedded items included, from the reliability pipeline), while a homebrew
 * statblock with no match still falls back to the existing Tier 3 synthesis
 * path (create_document). Drives the real MCP-server tool runners against
 * MockFoundry — not a hand-rolled fake — so this is the same glue a live
 * Foundry world would run.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { CompendiumEntry } from "@foundry-mcp-bridge/shared";
import { parseStatblock, importNpc, type ImportNpcDeps } from "@foundry-mcp-bridge/statblock-sync";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import type { RelayTransport } from "../../packages/mcp-server/src/relay-transport.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";
import {
  runSearchCompendium,
  runImportFromCompendium,
  runCreateDocument,
} from "../../packages/mcp-server/src/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadStatblock(filename: string) {
  const filePath = path.join(__dirname, "..", "fixtures", "statblock-import", filename);
  return parseStatblock(fs.readFileSync(filePath, "utf-8"));
}

/** Unwraps a tool outcome or throws, so realDeps below doesn't repeat the check 3x. */
function unwrap<T>(out: ToolOutcome, label: string): T {
  if (!out.ok) throw new Error(`${label} failed: ${out.error.code}`);
  return out.data as T;
}

/** Wires importNpc's injected deps to the real reliability pipeline + tool runners. */
function realDeps(transport: RelayTransport): ImportNpcDeps {
  return {
    async searchCompendium(nameQuery) {
      return unwrap<CompendiumEntry[]>(
        await runSearchCompendium(transport, { documentType: "Actor", nameQuery }),
        "searchCompendium",
      );
    },
    async importFromCompendium(uuid, patch) {
      return unwrap<{ _id: string }>(
        await runImportFromCompendium(transport, { documentType: "Actor", uuid, patch }),
        "importFromCompendium",
      );
    },
    async createDocument(data) {
      return unwrap<{ _id: string }>(
        await runCreateDocument(transport, { documentType: "Actor", data: data as unknown as Record<string, unknown> }),
        "createDocument",
      );
    },
  };
}

describe("importNpc: Tier 1 compendium match wired into the import pipeline", () => {
  it("clones the matching SRD compendium actor instead of synthesizing one", async () => {
    const mock = new MockFoundry();
    const transport = new MockTransport(mock);
    // Gravemire Stalker's homebrew statblock note happens to share its name
    // with the vendored SRD compendium fixture, so this must Tier-1-match.
    const statblock = loadStatblock("gravemire-stalker.md");

    const result = await importNpc(statblock, realDeps(transport));

    expect(result.tier).toBe(1);
    expect(result.matchedUuid).toBe("Compendium.dnd5e.actors24.gravemire-stalker");

    const actors = mock.documents("Actor") as Array<{ _id: string; name: string; type: string; items?: unknown[] }>;
    const imported = actors.find((a) => a._id === result.actorId);
    expect(imported).toBeDefined();
    // Cloned from the compendium fixture: real subtype ("npc") and its 5
    // embedded items, not the (possibly different) shape synthesis would produce.
    expect(imported!.name).toBe("Gravemire Stalker");
    expect(imported!.type).toBe("npc");
    expect(imported!.items).toHaveLength(5);
  });

  it("falls back to Tier 3 synthesis for a statblock with no compendium match", async () => {
    const mock = new MockFoundry();
    const transport = new MockTransport(mock);
    // A homebrew statblock with a name that doesn't exist in any compendium.
    const statblock = loadStatblock("gravemire-stalker.md");
    statblock.data.name = "Completely Homebrew Bog Horror";

    const result = await importNpc(statblock, realDeps(transport));

    expect(result.tier).toBe(3);
    expect(result.matchedUuid).toBeUndefined();

    const actors = mock.documents("Actor") as Array<{ _id: string; name: string }>;
    const created = actors.find((a) => a._id === result.actorId);
    expect(created).toBeDefined();
    expect(created!.name).toBe("Completely Homebrew Bog Horror");
  });
});
