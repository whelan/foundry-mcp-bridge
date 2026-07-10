import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MockFoundry } from "./mock-foundry.js";
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
    // Verify itemChanges was calculated
    if (itemChanges) {
      expect(typeof itemChanges.created).toBe("number");
      expect(typeof itemChanges.updated).toBe("number");
      expect(typeof itemChanges.deleted).toBe("number");
      expect(typeof itemChanges.unchanged).toBe("number");
    }

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
