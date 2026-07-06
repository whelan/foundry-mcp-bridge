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

const statblock = loadStatblock("gravemire-stalker.md");

/** What the world hands back is (a superset of) what we wrote. */
function readBackFromConverter(): FoundryActorReadBack {
  return {
    _id: "test000000000000",
    ...(statblockToFoundryActor(statblock, "worlds/npcs/g/g.png") as any),
  };
}

describe("M5: verifyImportedNpc - Structured verification reports", () => {
  it("generates a report for a converted NPC with expected structure", () => {
    const readBack = readBackFromConverter();
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
    const readBack = readBackFromConverter();
    (readBack.system as any).attributes.ac.flat = 13;

    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    const acCheck = report.checks.find((c) => c.name.includes("AC"));
    expect(acCheck?.pass).toBe(false);
  });

  it("detects HP mismatch", () => {
    const readBack = readBackFromConverter();
    (readBack.system as any).attributes.hp.max = 50;

    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    const hpCheck = report.checks.find((c) => c.name.includes("HP"));
    expect(hpCheck?.pass).toBe(false);
  });

  it("detects missing image when one is expected", () => {
    const readBack = readBackFromConverter();
    readBack.img = undefined;
    readBack.prototypeToken = undefined;

    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    const imgCheck = report.checks.find((c) => c.name.includes("image"));
    expect(imgCheck?.pass).toBe(false);
  });

  it("passes when no image is in the statblock", () => {
    const noImageStatblock = { ...statblock, data: { ...statblock.data, image: undefined } };
    const actor = statblockToFoundryActor(noImageStatblock);
    const readBack: FoundryActorReadBack = { _id: "test-id", ...(actor as any) };

    const report = verifyImportedNpc(readBack, noImageStatblock);
    // Should have no image checks required
    const imgChecks = report.checks.filter((c) => c.name.includes("image"));
    expect(imgChecks.length).toBe(0);
  });

  it("supports tokenizer mode for reframed images", () => {
    const readBack = readBackFromConverter();
    readBack.img = "worlds/npcs/gravemire-stalker.Avatar.webp";
    readBack.prototypeToken = { texture: { src: "worlds/npcs/gravemire-stalker.Token.webp" } };

    const report = verifyImportedNpc(readBack, statblock, { tokenizeMode: true });
    const avatarCheck = report.checks.find((c) => c.name.includes(".Avatar.webp"));
    expect(avatarCheck?.pass).toBe(true);
    const tokenCheck = report.checks.find((c) => c.name.includes(".Token.webp"));
    expect(tokenCheck?.pass).toBe(true);
  });
});

describe("verifyImportedNpc against modern shapes", () => {
  it("passes on a faithful read-back", () => {
    const report = verifyImportedNpc(readBackFromConverter(), statblock);
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails the to-hit check when the attack activity bonus is wrong", () => {
    const rb = readBackFromConverter();
    const claw = rb.items!.find((i: any) => i.name === "Claw")!;
    const act: any = Object.values((claw.system as any).activities)[0];
    act.attack.bonus = "3";
    const report = verifyImportedNpc(rb, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === `"Claw" to-hit`)?.pass).toBe(false);
  });

  it("fails the DC check when the save activity formula is wrong", () => {
    const rb = readBackFromConverter();
    const breath = rb.items!.find((i: any) => i.name === "Grave Breath")!;
    const act: any = Object.values((breath.system as any).activities)[0];
    act.save.dc.formula = "15";
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === `"Grave Breath" save DC`)?.pass).toBe(false);
  });

  it("fails the recharge check when uses.recovery is missing", () => {
    const rb = readBackFromConverter();
    const breath = rb.items!.find((i: any) => i.name === "Grave Breath")!;
    (breath.system as any).uses = { spent: 0, recovery: [], max: "" };
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === `"Grave Breath" recharge`)?.pass).toBe(false);
  });

  it("checks skill and save proficiency multipliers", () => {
    const rb = readBackFromConverter();
    (rb.system as any).skills.ste = { value: 0 };
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === "Skill stealth proficient")?.pass).toBe(false);
  });

  it("checks darkvision range", () => {
    const rb = readBackFromConverter();
    (rb.system as any).attributes.senses.ranges.darkvision = null;
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === "Senses: darkvision 60 ft")?.pass).toBe(false);
  });
});
