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

  it("doesn't fail a calculated (non-flat) attack bonus -- official monsters derive to-hit at roll time", () => {
    const rb = readBackFromConverter();
    const claw = rb.items!.find((i: any) => i.name === "Claw")!;
    const act: any = Object.values((claw.system as any).activities)[0];
    act.attack.flat = false;
    delete act.attack.bonus;
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === `"Claw" to-hit`)).toBeUndefined();
    expect(report.checks.find((c) => c.name.includes("Claw") && c.name.includes("calculated to-hit"))?.pass).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("doesn't fail a calculated (ability-expression) save DC -- official monsters derive DC at roll time", () => {
    const rb = readBackFromConverter();
    const breath = rb.items!.find((i: any) => i.name === "Grave Breath")!;
    const act: any = Object.values((breath.system as any).activities)[0];
    act.save.dc.calculation = "con";
    act.save.dc.formula = "8 + @mod + @prof";
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === `"Grave Breath" save DC`)).toBeUndefined();
    expect(report.checks.find((c) => c.name.includes("Grave Breath") && c.name.includes("calculated DC"))?.pass).toBe(true);
    expect(report.ok).toBe(true);
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

describe("M5: verifyImportedNpc - legendary/lair resources", () => {
  function readBackWithLegendaryLair() {
    const sb = parseStatblock(`\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
traits:
  - name: Legendary Resistance (3/Day)
    desc: "If the dragon fails a saving throw, it can choose to succeed instead."
legendary_actions:
  - name: Detect
    desc: "The dragon makes a Wisdom (Perception) check."
lair_actions:
  - name: Volcanic Fissure
    desc: "Dexterity Saving Throw: DC 16, each creature standing in the new fissure. Failure: 10 (3d6) Fire damage."
\`\`\`
`);
    const rb: FoundryActorReadBack = {
      _id: "test000000000000",
      ...(statblockToFoundryActor(sb) as any),
    };
    return { statblock: sb, readBack: rb };
  }

  it("passes legact/legres/lair checks when resources match the statblock", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.checks.find((c) => c.name.includes("legact"))?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("legres"))?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("lair"))?.pass).toBe(true);
  });

  it("fails the legact check when resources.legact.max is wrong", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    (readBack.system as any).resources.legact.max = 0;
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("legact"))?.pass).toBe(false);
  });

  it("fails the legres check when resources.legres.max is wrong", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    (readBack.system as any).resources.legres.max = 0;
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("legres"))?.pass).toBe(false);
  });

  it("fails the lair-initiative check when it isn't 20", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    (readBack.system as any).resources.lair.initiative = null;
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("lair"))?.pass).toBe(false);
  });

  it("does not add legact/legres/lair checks for a statblock with none of these features", () => {
    const sb = parseStatblock(`\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
\`\`\`
`);
    const rb: FoundryActorReadBack = {
      _id: "test000000000000",
      ...(statblockToFoundryActor(sb) as any),
    };
    const report = verifyImportedNpc(rb, sb);
    expect(report.checks.some((c) => c.name.includes("legact"))).toBe(false);
    expect(report.checks.some((c) => c.name.includes("legres"))).toBe(false);
    expect(report.checks.some((c) => c.name.includes("lair"))).toBe(false);
  });
});

describe("M5: verifyImportedNpc - spellcasting", () => {
  // CR 12 -> proficiency +4; Intelligence 20 -> mod +5; 8+4+5=17 (DC), 4+5=9 (attack) —
  // matches the trait text below, so the derivation checks pass on an internally-consistent statblock.
  const spellcasterStatblock = parseStatblock(`\`\`\`statblock
name: Test Archmage
cr: 12
ac: 12
hp: 100
stats: [10, 14, 12, 20, 15, 16]
traits:
  - name: Spellcasting
    desc: "The archmage is a level 18 spellcaster. Its spellcasting ability is Intelligence (spell save DC 17, +9 to hit with spell attacks). The archmage has the following wizard spells prepared: Cantrips (at will): fire bolt, light 1st level (4 slots): detect magic, shield"
\`\`\`
`);

  function readBackWithSpells(): FoundryActorReadBack {
    const converted = statblockToFoundryActor(spellcasterStatblock) as any;
    return {
      _id: "test000000000000",
      ...converted,
      items: [
        ...converted.items,
        {
          name: "Fire Bolt",
          type: "spell",
          img: "icons/magic/fire.webp",
          _stats: { compendiumSource: "Compendium.dnd5e.spells24.fire-bolt" },
        },
        { name: "Light", type: "spell", img: "icons/svg/book.svg" }, // placeholder: no _stats
        {
          name: "Detect Magic",
          type: "spell",
          img: "icons/magic/detect.webp",
          _stats: { compendiumSource: "Compendium.dnd5e.spells24.detect-magic" },
        },
        {
          name: "Shield",
          type: "spell",
          img: "icons/magic/shield.webp",
          _stats: { compendiumSource: "Compendium.dnd5e.spells24.shield" },
        },
      ],
    };
  }

  it("passes ability/DC/attack-bonus/slot checks for an internally-consistent statblock", () => {
    const report = verifyImportedNpc(readBackWithSpells(), spellcasterStatblock);
    expect(report.checks.find((c) => c.name === "Spellcasting ability")?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("DC"))?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("attack bonus"))?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("level 1"))?.pass).toBe(true);
  });

  it("passes the official-item check for a compendium-sourced spell and fails it for a placeholder", () => {
    const report = verifyImportedNpc(readBackWithSpells(), spellcasterStatblock);
    expect(report.checks.find((c) => c.name.includes('"fire bolt"'))?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes('"light"'))?.pass).toBe(false);
  });

  it("fails the attached check when a spell name has no matching item at all", () => {
    const rb = readBackWithSpells();
    rb.items = rb.items!.filter((i) => i.name !== "Detect Magic");
    const report = verifyImportedNpc(rb, spellcasterStatblock);
    expect(report.checks.find((c) => c.name === 'Spell "detect magic" attached')?.pass).toBe(false);
  });
});
