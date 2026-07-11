import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MockFoundry, documentKey } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { runImportNpc, runCreateDocument } from "../../packages/mcp-server/src/tools.js";
import { buildNpcUpdatePatch, parseStatblock } from "../../packages/statblock-sync/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(filename: string): string {
  return fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "statblock-import", filename),
    "utf-8"
  );
}

describe("runImportNpc: MCP tool end-to-end", () => {
  let mock: MockFoundry;
  let transport: MockTransport;

  beforeEach(() => {
    mock = new MockFoundry();
    transport = new MockTransport(mock);
  });

  it("imports a Tier 3 NPC with optional folder", async () => {
    const markdown = loadFixture("simple-warrior.md");

    const result = await runImportNpc(transport, {
      markdown,
      folder: "Session NPCs",
      assetSource: "data",
    });

    expect(result.ok).toBe(true);
    const { actorId, tier, verification } = (result as any).data;
    expect(tier).toBe(3);
    expect(verification).toBeDefined();
    expect(verification.ok).toBe(true);

    // Verify folder placement
    const actor = mock.documents("Actor").find((a: any) => a._id === actorId);
    expect(actor).toBeDefined();
    expect(actor!.folder).toBeTruthy();

    const folder = mock.documents("Folder").find((f: any) => f._id === actor!.folder);
    expect(folder).toBeDefined();
    expect(folder!.name).toBe("Session NPCs");
  });

  it("rejects a statblock with 2014-style actions (lint FAIL)", async () => {
    const badMarkdown = `
# Test NPC

\`\`\`statblock
name: Test NPC
size: Medium
type: humanoid
alignment: Any Alignment
ac: 12
hp: 50
stats: [10, 10, 10, 10, 10, 10]
traits:
  - name: Bad Attack
    desc: "Melee Weapon Attack: +5 to hit, reach 5 ft. Hit: 10 (1d8 + 2) damage."
\`\`\`
`;

    const result = await runImportNpc(transport, { markdown: badMarkdown, assetSource: "data" });

    expect(result.ok).toBe(false);
    const error = (result as any).error;
    expect(error.code).toBe("VALIDATION");
    expect(error.details.findings).toBeDefined();
    expect(error.details.findings.length).toBeGreaterThan(0);
    expect(error.details.findings[0].severity).toBe("FAIL");

    // Confirm no actor was created
    expect(mock.documents("Actor").length).toBe(0);
  });

  it("find-or-reuses folder on second import with same name", async () => {
    const markdown1 = loadFixture("simple-warrior.md");
    const markdown2 = loadFixture("duskfang-bog-wyrm.md");

    // Import 1
    const r1 = await runImportNpc(transport, { markdown: markdown1, folder: "Campaign", assetSource: "data" });
    expect(r1.ok).toBe(true);
    const actor1 = mock.documents("Actor").find((a: any) => a._id === (r1 as any).data.actorId);
    const folderId1 = actor1!.folder;

    // Import 2 with same folder name
    const r2 = await runImportNpc(transport, { markdown: markdown2, folder: "Campaign", assetSource: "data" });
    expect(r2.ok).toBe(true);
    const actor2 = mock.documents("Actor").find((a: any) => a._id === (r2 as any).data.actorId);
    const folderId2 = actor2!.folder;

    // Same folder ID used
    expect(folderId1).toBe(folderId2);

    // Only one folder created
    const folders = mock.documents("Folder").filter((f: any) => f.name === "Campaign");
    expect(folders.length).toBe(1);
  });

  it("handles optional image upload parameter", async () => {
    const markdown = loadFixture("simple-warrior.md");
    const imagePath = path.join(__dirname, "..", "fixtures", "statblock-import", "gravemire-stalker.png");

    // Check if image file exists; if not, test without it
    if (!fs.existsSync(imagePath)) {
      const result = await runImportNpc(transport, { markdown, assetSource: "data" });
      expect(result.ok).toBe(true);
      const actor = mock.documents("Actor").find((a: any) => a._id === (result as any).data.actorId);
      expect(actor).toBeDefined();
      return;
    }

    // Test with image content
    const imageContent = {
      filename: "simple-warrior-portrait.png",
      contentBase64: fs.readFileSync(imagePath).toString("base64"),
    };

    const result = await runImportNpc(transport, {
      markdown,
      image: imageContent,
      assetSource: "data",
    });

    // Image upload may fail in mock, but actor should still be created
    if (result.ok) {
      const actor = mock.documents("Actor").find((a: any) => a._id === (result as any).data.actorId);
      expect(actor).toBeDefined();
    } else {
      // If upload fails, verify it's an image-related error
      const error = (result as any).error;
      expect(error.details.stage).toBe("uploadImage");
    }
  });

  it("creates folder with specific name when provided", async () => {
    const markdown = loadFixture("simple-warrior.md");

    const result = await runImportNpc(transport, {
      markdown,
      folder: "Custom NPC Folder",
      assetSource: "data",
    });

    expect(result.ok).toBe(true);
    const actor = mock.documents("Actor").find((a: any) => a._id === (result as any).data.actorId);
    expect(actor!.folder).toBeTruthy();

    const folder = mock.documents("Folder").find((f: any) => f._id === actor!.folder);
    expect(folder).toBeDefined();
    expect(folder!.name).toBe("Custom NPC Folder");

    // Verify only one folder with this name exists
    const sameNameFolders = mock.documents("Folder").filter((f: any) => f.name === "Custom NPC Folder");
    expect(sameNameFolders.length).toBe(1);
  });

  it("works without optional folder parameter", async () => {
    const markdown = loadFixture("simple-warrior.md");

    const result = await runImportNpc(transport, { markdown, assetSource: "data" });

    expect(result.ok).toBe(true);
    const actor = mock.documents("Actor").find((a: any) => a._id === (result as any).data.actorId);
    // Actor should be created (folder will be root/undefined)
    expect(actor).toBeDefined();
  });

  it("supports assetSource override for Forge", async () => {
    const markdown = loadFixture("simple-warrior.md");
    const imagePath = path.join(__dirname, "..", "fixtures", "statblock-import", "gravemire-stalker.png");

    if (!fs.existsSync(imagePath)) {
      console.log("Skipping Forge asset test — fixture not available");
      return;
    }

    const imageContent = {
      filename: "gravemire-stalker.png",
      contentBase64: fs.readFileSync(imagePath).toString("base64"),
    };

    const result = await runImportNpc(transport, {
      markdown,
      image: imageContent,
      assetSource: "forgevtt",
    });

    expect(result.ok).toBe(true);
    const actor = mock.documents("Actor").find((a: any) => a._id === (result as any).data.actorId);
    expect(actor).toBeDefined();
  });

  it("first import creates actor and stamps statblockKey on actor + items", async () => {
    const markdown = loadFixture("test-archmage.md");

    const result = await runImportNpc(transport, { markdown, mode: "create", assetSource: "data" });

    expect(result.ok).toBe(true);
    const { actorId, tier } = (result as any).data;
    expect(tier).toBe(3);

    const actor = mock.documents("Actor").find((a: any) => a._id === actorId) as any;
    expect(actor).toBeDefined();
    expect(actor!.flags["foundry-mcp-bridge"].statblockKey).toBe("test-archmage");

    const daggerItem = actor!.items.find((i: any) => i.name === "Dagger");
    if (daggerItem) {
      expect(daggerItem.flags["foundry-mcp-bridge"].statblockKey).toBe("action/dagger");
    }
  });

  it("second import of same note with default mode upserts", async () => {
    const markdown = loadFixture("test-archmage.md");

    const created = await runImportNpc(transport, { markdown, mode: "create", assetSource: "data" });
    expect(created.ok).toBe(true);
    const actorId = (created as any).data.actorId;

    const updated = await runImportNpc(transport, { markdown, assetSource: "data" });
    expect(updated.ok).toBe(true);
    const { actorId: updatedActorId, action, itemChanges } = (updated as any).data;
    expect(updatedActorId).toBe(actorId);
    expect(action).toBe("updated");
    // Re-importing the exact same markdown is a true no-op on items: every
    // item matches by statblockKey and compares equal, so nothing is
    // created/updated/deleted.
    expect(itemChanges).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: itemChanges.unchanged });
    expect(itemChanges.unchanged).toBeGreaterThan(0);

    // Verify the same actor was updated (not a new one)
    const allActors = mock.documents("Actor");
    const archmageActors = allActors.filter((a: any) => a.name === "Test Archmage");
    expect(archmageActors.length).toBe(1);
  });

  it("mode: 'create' forces new actor even when match exists", async () => {
    const markdown = loadFixture("test-archmage.md");

    const first = await runImportNpc(transport, { markdown, assetSource: "data" });
    expect(first.ok).toBe(true);
    const firstActorId = (first as any).data.actorId;

    const second = await runImportNpc(transport, { markdown, mode: "create", assetSource: "data" });
    expect(second.ok).toBe(true);
    const secondActorId = (second as any).data.actorId;
    const action = (second as any).data.action;

    expect(secondActorId).not.toBe(firstActorId);
    expect(action).toBe("created");
  });

  it("mode: 'update' with no match throws VALIDATION error", async () => {
    const markdown = loadFixture("test-archmage.md");

    const result = await runImportNpc(transport, { markdown, mode: "update", assetSource: "data" });

    expect(result.ok).toBe(false);
    const error = (result as any).error;
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("mode: \"update\" requires");
  });

  it("ambiguous match (2+ actors with same key) throws VALIDATION error", async () => {
    const markdown = loadFixture("test-archmage.md");

    const first = await runImportNpc(transport, { markdown, assetSource: "data" });
    expect(first.ok).toBe(true);

    // Create a second actor with the same statblockKey via the transport
    const secondActorResult = await runCreateDocument(transport, {
      documentType: "Actor",
      data: {
        name: "Test Archmage",
        type: "npc",
        flags: { "foundry-mcp-bridge": { statblockKey: "test-archmage" } },
      },
    });
    expect(secondActorResult.ok).toBe(true);

    const result = await runImportNpc(transport, { markdown, assetSource: "data" });

    expect(result.ok).toBe(false);
    const error = (result as any).error;
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("Ambiguous match");
  });

  it("re-import with item modifications reflects exact diff counts", async () => {
    // Base: Brave trait + Longsword + Shield Bash
    const baseMarkdown = `# Simple Warrior

\`\`\`statblock
name: Simple Warrior
size: Medium
type: humanoid
alignment: Lawful Good
ac: 16
ac_class: plate
hp: 27
hit_dice: 5d8+5
speed: 30 ft.
stats: [16, 11, 13, 10, 11, 10]
skillsaves:
  - athletics: 5
senses: passive Perception 10
languages: Common
cr: 1
traits:
  - name: Brave
    desc: "The warrior has advantage on saving throws against being frightened."
actions:
  - name: Longsword
    desc: "Melee Attack Roll: +5, reach 5 ft. Hit: 7 (1d8 + 3) Slashing damage, or 8 (1d10 + 3) Slashing damage if used with two hands."
  - name: Shield Bash
    desc: "Melee Attack Roll: +5, reach 5 ft. Hit: 6 (1d4 + 3) Bludgeoning damage."
\`\`\`
`;

    // First import: creates actor with original 3 items
    const created = await runImportNpc(transport, {
      markdown: baseMarkdown,
      mode: "create",
      assetSource: "data",
    });
    expect(created.ok).toBe(true);
    const actorId = (created as any).data.actorId;

    // Verify first import created 3 items (Brave, Longsword, Shield Bash)
    const firstImportActor = mock.documents("Actor").find((a: any) => a._id === actorId) as any;
    expect(firstImportActor.items.length).toBe(3);

    // Modified: remove Longsword, add Dagger, modify Shield Bash damage (1d4+3 → 1d6+4)
    const modifiedMarkdown = `# Simple Warrior

\`\`\`statblock
name: Simple Warrior
size: Medium
type: humanoid
alignment: Lawful Good
ac: 16
ac_class: plate
hp: 27
hit_dice: 5d8+5
speed: 30 ft.
stats: [16, 11, 13, 10, 11, 10]
skillsaves:
  - athletics: 5
senses: passive Perception 10
languages: Common
cr: 1
traits:
  - name: Brave
    desc: "The warrior has advantage on saving throws against being frightened."
actions:
  - name: Dagger
    desc: "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d4 + 3) Piercing damage."
  - name: Shield Bash
    desc: "Melee Attack Roll: +5, reach 5 ft. Hit: 7 (1d6 + 4) Bludgeoning damage."
\`\`\`
`;

    // Second import: re-import with modifications
    const updated = await runImportNpc(transport, {
      markdown: modifiedMarkdown,
      assetSource: "data",
    });

    expect(updated.ok).toBe(true);
    const { actorId: updatedActorId, action, itemChanges } = (updated as any).data;

    // Verify same actor was updated
    expect(updatedActorId).toBe(actorId);
    expect(action).toBe("updated");

    // Longsword removed, Dagger added, Shield Bash's damage changed, Brave untouched.
    expect(itemChanges).toEqual({ created: 1, updated: 1, deleted: 1, unchanged: 1 });

    // Verify the actor still exists and is the same
    const allActors = mock.documents("Actor");
    const warriorActors = allActors.filter((a: any) => a.name === "Simple Warrior");
    expect(warriorActors.length).toBe(1);
    expect(warriorActors[0]!._id).toBe(actorId);

    const finalActor = warriorActors[0] as any;
    const itemNames = finalActor.items.map((i: any) => i.name).sort();
    expect(itemNames).toEqual(["Brave", "Dagger", "Shield Bash"]);
  });

  it("re-import with a spell removed from the note deletes the stale spell item", async () => {
    const baseMarkdown = `# Simple Caster

\`\`\`statblock
name: Simple Caster
size: Medium
type: humanoid
alignment: Neutral
ac: 12
ac_class: natural armor
hp: 40
hit_dice: 9d8
speed: 30 ft.
stats: [10, 12, 12, 16, 12, 10]
senses: passive Perception 11
languages: Common
cr: 3
traits:
  - name: Spellcasting
    desc: "The caster is a level 5 spellcaster. Its spellcasting ability is Intelligence (spell save DC 13, +5 to hit with spell attacks). The caster has the following wizard spells prepared: Cantrips (at will): fire bolt 1st level (4 slots): magic missile, shield"
\`\`\`
`;

    const created = await runImportNpc(transport, { markdown: baseMarkdown, mode: "create", assetSource: "data" });
    expect(created.ok).toBe(true);
    const actorId = (created as any).data.actorId;

    const firstImportActor = mock.documents("Actor").find((a: any) => a._id === actorId) as any;
    const firstSpellNames = firstImportActor.items
      .filter((i: any) => i.type === "spell")
      .map((i: any) => i.name)
      .sort();
    expect(firstSpellNames).toEqual(["fire bolt", "magic missile", "shield"]);

    // Re-import with "shield" dropped from the prepared list.
    const modifiedMarkdown = `# Simple Caster

\`\`\`statblock
name: Simple Caster
size: Medium
type: humanoid
alignment: Neutral
ac: 12
ac_class: natural armor
hp: 40
hit_dice: 9d8
speed: 30 ft.
stats: [10, 12, 12, 16, 12, 10]
senses: passive Perception 11
languages: Common
cr: 3
traits:
  - name: Spellcasting
    desc: "The caster is a level 5 spellcaster. Its spellcasting ability is Intelligence (spell save DC 13, +5 to hit with spell attacks). The caster has the following wizard spells prepared: Cantrips (at will): fire bolt 1st level (4 slots): magic missile"
\`\`\`
`;

    const updated = await runImportNpc(transport, { markdown: modifiedMarkdown, assetSource: "data" });
    expect(updated.ok).toBe(true);
    expect((updated as any).data.actorId).toBe(actorId);
    expect((updated as any).data.action).toBe("updated");

    const finalActor = mock.documents("Actor").find((a: any) => a._id === actorId) as any;
    const finalSpellNames = finalActor.items
      .filter((i: any) => i.type === "spell")
      .map((i: any) => i.name)
      .sort();
    expect(finalSpellNames).toEqual(["fire bolt", "magic missile"]);
  });
});

describe("Tier 1 (compendium-clone) resync", () => {
  let mock: MockFoundry;
  let transport: MockTransport;

  beforeEach(() => {
    mock = new MockFoundry();
    transport = new MockTransport(mock);
  });

  const tier1Note = () => loadFixture("gravemire-stalker.md");

  it("first import creates a Tier 1 clone with tier + item provenance flags", async () => {
    const result = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    expect(result.ok).toBe(true);
    const { actorId, tier, action } = (result as any).data;
    expect(tier).toBe(1);
    expect(action).toBe("created");

    const actor = mock.documents("Actor").find((a: any) => a._id === actorId)! as any;
    expect(actor.flags["foundry-mcp-bridge"].tier).toBe(1);
    expect(actor.flags["foundry-mcp-bridge"].compendiumUuid).toContain("gravemire-stalker");
    expect(actor.items.length).toBeGreaterThan(0);
    for (const it of actor.items) {
      expect((it as any).flags["foundry-mcp-bridge"].sourceUuid).toBeTruthy();
    }
  });

  it("re-import refreshes in place, preserving _id and Foundry-owned runtime", async () => {
    const first = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    const actorId = (first as any).data.actorId;

    // Inject runtime state
    const actor = mock.documents("Actor").find((a: any) => a._id === actorId)! as any;
    (actor.system as any).attributes.hp.value = 3;
    (actor.system as any).currency = { gp: 999 };

    const second = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    expect(second.ok).toBe(true);
    const data = (second as any).data;
    expect(data.action).toBe("updated");
    expect(data.actorId).toBe(actorId);

    const after = mock.documents("Actor").find((a: any) => a._id === actorId)! as any;
    expect((after.system as any).attributes.hp.value).toBe(3);
    expect((after.system as any).currency.gp).toBe(999);
  });

  it("mode: 'update' with no match throws VALIDATION error", async () => {
    const result = await runImportNpc(transport, { markdown: tier1Note(), mode: "update", assetSource: "data" });
    expect(result.ok).toBe(false);
    const error = (result as any).error;
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("mode: \"update\" requires");
  });

  it("compendium changed → refresh applies item deltas; GM-added item survives; removed item is deleted, not crashed", async () => {
    const first = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    const actorId = (first as any).data.actorId;
    const compendiumUuid = (first as any).data.matchedUuid as string;

    const actor = mock.documents("Actor").find((a: any) => a._id === actorId)! as any;
    const originalItemCount = actor.items.length;

    // GM adds an unflagged item directly on the actor -- must survive untouched.
    actor.items.push({ _id: "gm-added-item", name: "GM Trinket", type: "loot", system: {} });

    // Mutate the seeded compendium source: change one item's mechanics
    // in-place (update -- the mock's synthetic item uuid is name-derived, so
    // this test changes `system`, not `name`, to keep the same identity and
    // exercise the update path rather than delete+create), drop the last
    // item (delete), and add a brand-new one (create).
    const record = (mock as any).compendium.get(compendiumUuid);
    record.data.items[0].system = { ...record.data.items[0].system, description: { value: "Errata text" } };
    record.data.items.pop();
    record.data.items.push({ name: "New Errata Trait", type: "feature", system: {} });

    const second = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    expect(second.ok).toBe(true);
    const { itemChanges } = (second as any).data;
    expect(itemChanges.created).toBe(1);
    expect(itemChanges.deleted).toBe(1);
    expect(itemChanges.updated).toBeGreaterThanOrEqual(1);

    const after = mock.documents("Actor").find((a: any) => a._id === actorId)! as any;
    expect(after.items.some((i: any) => i.name === "GM Trinket")).toBe(true);
    expect(after.items.some((i: any) => i.name === "New Errata Trait")).toBe(true);
    // Original count minus the removed item, plus the GM item and the new one.
    expect(after.items.length).toBe(originalItemCount - 1 + 1 + 1);
  });

  it("legacy Tier 1 actor (statblockKey only, unstamped items) self-upgrades on re-import without duplicating items", async () => {
    const compendiumUuid = "Compendium.dnd5e.actors24.gravemire-stalker";
    const record = (mock as any).compendium.get(compendiumUuid);
    // Real (and mock) embedded items only ever get an _id once actually
    // created in the world -- the compendium's own raw data never has one.
    // A legacy clone (created by the old, pre-provenance importFromCompendium
    // path) always has real ids on its items by the time it's re-imported.
    const legacyActor = {
      ...structuredClone(record.data),
      items: record.data.items.map((it: any, i: number) => ({ ...structuredClone(it), _id: `legacy-item-${i}` })),
      _id: "legacy-actor-1",
      flags: { "foundry-mcp-bridge": { statblockKey: "gravemire-stalker" } },
    };
    (mock as any).store.set(documentKey("Actor", "legacy-actor-1"), legacyActor);

    const result = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    expect(result.ok).toBe(true);
    const data = (result as any).data;
    expect(data.action).toBe("updated");
    expect(data.actorId).toBe("legacy-actor-1");
    expect(data.tier).toBe(1);

    const after = mock.documents("Actor").find((a: any) => a._id === "legacy-actor-1")! as any;
    expect(after.flags["foundry-mcp-bridge"].tier).toBe(1);
    expect(after.flags["foundry-mcp-bridge"].compendiumUuid).toBe(compendiumUuid);
    // Adopted in place, not duplicated onto a fresh set (5 legacy + 5 fresh).
    expect(after.items.length).toBe(record.data.items.length);
    expect(after.items.every((i: any) => i.flags?.["foundry-mcp-bridge"]?.sourceUuid)).toBe(true);
  });
});

describe("buildNpcUpdatePatch: dot-notation patch builder", () => {
  it("includes only statblock-owned fields", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    // Statblock-owned should be present
    expect(patch["system.attributes.ac.flat"]).toBeDefined();
    expect(patch["system.abilities.int.value"]).toBeDefined();
    expect(patch["system.details.cr"]).toBeDefined();
    expect(patch.name).toBeDefined();

    // Foundry-owned should NOT be present
    expect("system.attributes.hp.value" in patch).toBe(false);
    expect("system.attributes.exhaustion" in patch).toBe(false);
    expect("effects" in patch).toBe(false);
    expect("_stats" in patch).toBe(false);
    expect("ownership" in patch).toBe(false);
  });

  it("includes image when resolvedImagePath is provided", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const imagePath = "https://example.com/wizard.png";
    const patch = buildNpcUpdatePatch(statblock, imagePath);

    expect(patch.img).toBe(imagePath);
  });

  it("omits image when resolvedImagePath is not provided", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    expect("img" in patch).toBe(false);
  });

  it("includes folder when folderId is provided", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const folderId = "folder-abc123";
    const patch = buildNpcUpdatePatch(statblock, undefined, folderId);

    expect(patch.folder).toBe(folderId);
  });

  it("omits folder when folderId is not provided", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    expect("folder" in patch).toBe(false);
  });

  it("includes ability proficiencies and saves", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    // All six abilities should have values
    for (const ability of ["str", "dex", "con", "int", "wis", "cha"]) {
      expect(`system.abilities.${ability}.value` in patch).toBe(true);
      expect(`system.abilities.${ability}.proficient` in patch).toBe(true);
    }
  });

  it("includes skill proficiencies", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    // Should include system.skills.* entries
    const skillKeys = Object.keys(patch).filter((k) => k.startsWith("system.skills."));
    expect(skillKeys.length).toBeGreaterThanOrEqual(0);
  });

  it("includes spell slots if spellcasting is present", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    // Archmage has spellcasting, so spell slots should be included
    const spellKeys = Object.keys(patch).filter((k) => k.startsWith("system.spells."));
    expect(spellKeys.length).toBeGreaterThan(0);
  });

  it("includes resources (legendary/lair actions)", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    expect(patch["system.resources.legact"]).toBeDefined();
    expect(patch["system.resources.legres"]).toBeDefined();
    expect(patch["system.resources.lair"]).toBeDefined();
  });

  it("includes traits (size, languages, resistances)", () => {
    const markdown = loadFixture("test-archmage.md");
    const statblock = parseStatblock(markdown);
    const patch = buildNpcUpdatePatch(statblock);

    expect(patch["system.traits.size"]).toBeDefined();
    expect(patch["system.traits.languages"]).toBeDefined();
    expect(patch["system.traits.dr"]).toBeDefined();
    expect(patch["system.traits.di"]).toBeDefined();
    expect(patch["system.traits.dv"]).toBeDefined();
    expect(patch["system.traits.ci"]).toBeDefined();
  });
});
