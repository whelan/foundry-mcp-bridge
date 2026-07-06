/**
 * M5: Verification report tests - verify imported NPCs against source statblocks.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseStatblock,
  statblockToFoundryActor,
  verifyImportedNpc,
  type FoundryActorReadBack,
} from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadStatblock(filename: string) {
  const filePath = path.join(__dirname, "..", "fixtures", "statblock-import", filename);
  return parseStatblock(fs.readFileSync(filePath, "utf-8"));
}

describe("M5: verifyImportedNpc - Structured verification reports", () => {
  it("generates a report for a converted NPC with expected structure", () => {
    const statblock = loadStatblock("gravemire-stalker.md");
    const actor = statblockToFoundryActor(statblock, "worlds/npcs/gravemire-stalker.png");

    // Simulate a read-back from the world
    const readBack: FoundryActorReadBack = {
      _id: "test-id",
      name: actor.name,
      type: actor.type as string,
      img: actor.img,
      prototypeToken: actor.prototypeToken,
      system: actor.system,
      items: actor.items,
    };

    const report = verifyImportedNpc(readBack, statblock);

    // Verify the report structure exists
    expect(report.checks.length).toBeGreaterThan(0);

    // Core metadata should pass
    const nameCheck = report.checks.find((c) => c.name.includes("name matches"));
    expect(nameCheck?.pass).toBe(true);

    // AC should match
    const acCheck = report.checks.find((c) => c.name.includes("AC"));
    expect(acCheck?.pass).toBe(true);
  });

  it("detects AC mismatch", () => {
    const statblock = loadStatblock("gravemire-stalker.md");
    const actor = statblockToFoundryActor(statblock);

    const readBack: FoundryActorReadBack = {
      _id: "test-id",
      name: actor.name,
      type: "npc",
      system: {
        ...actor.system,
        attributes: {
          ac: { flat: 13 }, // Wrong AC
          hp: { max: 45 },
        },
      } as any,
    };

    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    const acCheck = report.checks.find((c) => c.name.includes("AC"));
    expect(acCheck?.pass).toBe(false);
  });

  it("detects HP mismatch", () => {
    const statblock = loadStatblock("gravemire-stalker.md");
    const actor = statblockToFoundryActor(statblock);

    const readBack: FoundryActorReadBack = {
      _id: "test-id",
      name: actor.name,
      type: "npc",
      system: {
        ...actor.system,
        attributes: {
          ac: { flat: 14 },
          hp: { max: 50 }, // Wrong HP
        },
      } as any,
    };

    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    const hpCheck = report.checks.find((c) => c.name.includes("HP"));
    expect(hpCheck?.pass).toBe(false);
  });

  it("detects missing image when one is expected", () => {
    const statblock = loadStatblock("gravemire-stalker.md");
    const actor = statblockToFoundryActor(statblock, "worlds/npcs/gravemire-stalker.png");

    const readBack: FoundryActorReadBack = {
      _id: "test-id",
      name: actor.name,
      type: "npc",
      // No img or prototypeToken set
      system: actor.system,
    };

    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    const imgCheck = report.checks.find((c) => c.name.includes("image"));
    expect(imgCheck?.pass).toBe(false);
  });

  it("passes when no image is in the statblock", () => {
    const statblock = loadStatblock("gravemire-stalker.md");
    statblock.data.image = undefined;
    const actor = statblockToFoundryActor(statblock);

    const readBack: FoundryActorReadBack = {
      _id: "test-id",
      name: actor.name,
      type: "npc",
      system: actor.system,
    };

    const report = verifyImportedNpc(readBack, statblock);
    // Should pass (no image checks required)
    const imgChecks = report.checks.filter((c) => c.name.includes("image"));
    expect(imgChecks.length).toBe(0);
  });

  it("supports tokenizer mode for reframed images", () => {
    const statblock = loadStatblock("gravemire-stalker.md");
    const actor = statblockToFoundryActor(statblock, "worlds/npcs/gravemire-stalker.Avatar.webp");

    const readBack: FoundryActorReadBack = {
      _id: "test-id",
      name: actor.name,
      type: "npc",
      img: "worlds/npcs/gravemire-stalker.Avatar.webp",
      prototypeToken: { texture: { src: "worlds/npcs/gravemire-stalker.Token.webp" } },
      system: actor.system,
    };

    const report = verifyImportedNpc(readBack, statblock, { tokenizeMode: true });
    const avatarCheck = report.checks.find((c) => c.name.includes(".Avatar.webp"));
    expect(avatarCheck?.pass).toBe(true);
    const tokenCheck = report.checks.find((c) => c.name.includes(".Token.webp"));
    expect(tokenCheck?.pass).toBe(true);
  });
});
