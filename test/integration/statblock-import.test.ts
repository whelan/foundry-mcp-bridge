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
import { parseStatblock, importNpc, verifyImportedNpc, type ImportNpcDeps } from "@foundry-mcp-bridge/statblock-sync";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import type { RelayTransport } from "../../packages/mcp-server/src/relay-transport.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";
import {
  runSearchCompendium,
  runImportFromCompendium,
  runImportEmbeddedFromCompendium,
  runCreateDocument,
  runCreateEmbedded,
  runUploadAsset,
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
    async uploadImage(filename, contentBase64, targetFolder) {
      const { path } = unwrap<{ path: string }>(
        await runUploadAsset(transport, {
          source: "data",
          target: targetFolder ?? "worlds/npcs",
          filename,
          contentBase64,
        }),
        "uploadAsset",
      );
      return path;
    },
    async searchSpellCompendium(nameQuery) {
      return unwrap<CompendiumEntry[]>(
        await runSearchCompendium(transport, { documentType: "Item", nameQuery }),
        "searchSpellCompendium",
      );
    },
    async importEmbeddedFromCompendium(parentId, uuid) {
      const created = unwrap<Array<{ _id: string }>>(
        await runImportEmbeddedFromCompendium(transport, {
          parentType: "Actor",
          parentId,
          embeddedName: "Item",
          uuids: [{ uuid }],
        }),
        "importEmbeddedFromCompendium",
      );
      return created[0]!;
    },
    async createEmbeddedItem(parentId, data) {
      const created = unwrap<Array<{ _id: string }>>(
        await runCreateEmbedded(transport, {
          parentType: "Actor",
          parentId,
          embeddedName: "Item",
          data: [data],
        }),
        "createEmbeddedItem",
      );
      return created[0]!;
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

  it("imports a homebrew legendary-action NPC end-to-end, with legendary items correctly activated", async () => {
    const mock = new MockFoundry();
    const transport = new MockTransport(mock);
    const statblock = loadStatblock("duskfang-bog-wyrm.md");
    const imagePath = path.join(__dirname, "..", "fixtures", "statblock-import", "duskfang-bog-wyrm.png");
    const imageContent = {
      filename: "duskfang-bog-wyrm.png",
      contentBase64: fs.readFileSync(imagePath).toString("base64"),
    };

    const result = await importNpc(statblock, realDeps(transport), imageContent);

    expect(result.tier).toBe(3); // no compendium entry for a homebrew dragon
    const actors = mock.documents("Actor") as Array<{
      _id: string;
      name: string;
      type: string;
      img?: string;
      items?: Array<{ name: string; type: string; system?: Record<string, any> }>;
    }>;
    const created = actors.find((a) => a._id === result.actorId);
    expect(created).toBeDefined();
    expect(created!.name).toBe("Duskfang, the Bog Wyrm");
    expect(created!.type).toBe("npc");
    expect(created!.img).toMatch(/duskfang-bog-wyrm\.png$/);

    const expectActivationType = (names: string[], expectedType: string) => {
      for (const name of names) {
        const item = created!.items!.find((i) => i.name === name);
        expect(item, `${name} should exist as an item`).toBeDefined();
        const act = Object.values(item!.system!.activities as Record<string, any>)[0];
        expect(act.activation.type, `${name}'s activation`).toBe(expectedType);
      }
    };
    expectActivationType(["Detect", "Tail Attack", "Wing Buffet"], "legendary");
    expectActivationType(["Rising Mire", "Grasping Roots"], "lair");

    // Grasping Roots uses the 2024 header save form ("Strength Saving Throw:
    // DC 18") -- must parse as a mechanical save, not fall through to a
    // non-rollable utility activity.
    const roots = created!.items!.find((i) => i.name === "Grasping Roots")!;
    const rootsAct = Object.values(roots.system!.activities as Record<string, any>)[0];
    expect(rootsAct.type).toBe("save");
    expect(rootsAct.save).toEqual({ ability: ["str"], dc: { calculation: "", formula: "18" } });

    // The recharge-limited breath weapon still works alongside the legendary/lair actions.
    const breath = created!.items!.find((i) => i.name === "Miasmic Breath");
    expect(breath!.system!.uses).toEqual({
      spent: 0,
      max: "1",
      recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }],
    });
  });

  it("imports a homebrew legendary+lair+resistance NPC end-to-end with resources set", async () => {
    const mock = new MockFoundry();
    const transport = new MockTransport(mock);
    const statblock = loadStatblock("young-ash-wyrm.md");

    const result = await importNpc(statblock, realDeps(transport));

    expect(result.tier).toBe(3); // no compendium entry for a homebrew dragon
    const actors = mock.documents("Actor") as Array<{
      _id: string;
      name: string;
      system: Record<string, any>;
      items?: Array<{ name: string; type: string; system?: Record<string, any> }>;
    }>;
    const created = actors.find((a) => a._id === result.actorId)!;
    expect(created.name).toBe("Young Ash Wyrm");

    expect(created.system.resources.legact).toEqual({ max: 3, spent: 0 });
    expect(created.system.resources.legres).toEqual({ max: 3, spent: 0 });
    expect(created.system.resources.lair).toEqual({ value: true, initiative: 20, inside: false });

    const legres = created.items!.find((i) => i.name === "Legendary Resistance")!;
    expect(legres.system!.uses).toEqual({
      spent: 0,
      max: "3",
      recovery: [{ period: "day", formula: "", type: "recoverAll" }],
    });

    // "Wing Attack (Costs 2 Actions)" is a known limitation (see plan doc's
    // non-goals): dnd5e's sheet tracks total legendary-action budget, not a
    // per-action cost, so the "Costs 2 Actions" text is parse-and-ignore for
    // now (it stays in the item name; only "(Recharge N-M)" is stripped).
    const wingAttack = created.items!.find((i) => i.name === "Wing Attack (Costs 2 Actions)");
    expect(wingAttack).toBeDefined();
  });
});

describe("importNpc: spellcasting", () => {
  function seedSpells(mock: MockFoundry) {
    const spells24: Array<[string, string]> = [
      ["fire-bolt", "Fire Bolt"],
      ["light", "Light"],
      ["mage-hand", "Mage Hand"],
      ["prestidigitation", "Prestidigitation"],
      ["detect-magic", "Detect Magic"],
      ["mage-armor", "Mage Armor"],
      ["magic-missile", "Magic Missile"],
      ["shield", "Shield"],
      ["misty-step", "Misty Step"],
      ["suggestion", "Suggestion"],
      ["counterspell", "Counterspell"],
      ["fireball", "Fireball"],
      // deliberately no "Fly" entry — exercises the placeholder-fallback path
      ["dimension-door", "Dimension Door"],
      ["greater-invisibility", "Greater Invisibility"],
      ["cone-of-cold", "Cone of Cold"],
    ];
    for (const [slug, name] of spells24) {
      mock.compendium.set(`Compendium.dnd5e.spells24.${slug}`, {
        documentType: "Item",
        pack: "dnd5e.spells24",
        data: { name, type: "spell", system: { level: 0 } },
      });
    }
  }

  it("imports a spellcasting NPC, attaching real spells and a placeholder for the misspelled one", async () => {
    const mock = new MockFoundry();
    seedSpells(mock);
    const transport = new MockTransport(mock);
    const statblock = loadStatblock("test-archmage.md");

    const result = await importNpc(statblock, realDeps(transport));

    expect(result.tier).toBe(3);
    const actors = mock.documents("Actor") as Array<{
      _id: string;
      name: string;
      system: Record<string, any>;
      items: Array<{ name: string; type: string; _stats?: Record<string, any> }>;
    }>;
    const created = actors.find((a) => a._id === result.actorId)!;

    expect(created.system.attributes.spellcasting).toBe("int");
    expect(created.system.spells.spell1).toEqual({ value: 4, override: 4 });
    expect(created.system.spells.spell5).toEqual({ value: 1, override: 1 });

    const fireball = created.items.find((i) => i.name === "Fireball")!;
    expect(fireball._stats?.compendiumSource).toBe("Compendium.dnd5e.spells24.fireball");

    // "fli" (the misspelled "fly") has no compendium match -> placeholder item.
    const placeholder = created.items.find((i) => i.name === "fli")!;
    expect(placeholder).toBeDefined();
    expect(placeholder._stats?.compendiumSource).toBeUndefined();

    const report = verifyImportedNpc(
      { _id: created._id, name: created.name, type: "npc", system: created.system, items: created.items },
      statblock,
    );
    // The misspelled spell's failed check must surface explicitly, not pass silently.
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.name.includes('"fli"') && !c.pass)).toBe(true);
    // Everything else about spellcasting should still check out.
    expect(report.checks.find((c) => c.name === "Spellcasting ability")?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("DC"))?.pass).toBe(true);
  });
});
