/**
 * M4 Tests: Convert to Foundry dnd5e actor JSON
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStatblock, statblockToFoundryActor } from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("M4: Convert to Foundry dnd5e Actor", () => {
  it("creates valid actor document from statblock", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);

    const actor = statblockToFoundryActor(statblock);

    // Verify basic structure
    expect(actor.name).toBe("Gravemire Stalker");
    expect(actor.type).toBe("npc");
    expect(actor.system).toBeDefined();
    expect(actor.items).toBeDefined();
    expect(actor.effects).toBeDefined();
  });

  it("sets correct ability scores", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.abilities.str.value).toBe(16);
    expect(system.abilities.dex.value).toBe(14);
    expect(system.abilities.con.value).toBe(15);
    expect(system.abilities.int.value).toBe(6);
    expect(system.abilities.wis.value).toBe(12);
    expect(system.abilities.cha.value).toBe(8);
  });

  it("sets correct AC and HP", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.attributes.ac.flat).toBe(14);
    expect(system.attributes.hp.value).toBe(45);
    expect(system.attributes.hp.max).toBe(45);
    expect(system.attributes.hp.formula).toBe("7d8+14");
  });

  it("sets movement from the parsed speed", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.attributes.movement.walk).toBe(30);
    expect(system.attributes.movement.swim).toBe(20);
    expect(system.attributes.movement.units).toBe("ft");
  });

  it("does not assume a 30ft walk speed when speed is omitted", () => {
    const markdown = `\`\`\`statblock
name: Immobile Test
cr: 1
ac: 10
hp: 10
stats: [10, 10, 10, 10, 10, 10]
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.attributes.movement.walk).toBe(0);
  });

  it("sets CR and XP", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.details.cr).toBe(3);
    expect(system.details.xp).toBe(700);
  });

  it("includes traits and resistances", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.traits_.damageResistances.value).toContain("necrotic");
    expect(system.traits.senses).toContain("darkvision");
  });

  it("sets creature type, size, and alignment from the descriptor line", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.details.type.value).toBe("undead");
    expect(system.details.size).toBe("med");
    expect(system.details.alignment).toBe("Neutral Evil");
  });

  it("sets prototypeToken texture to match the actor image", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    expect(actor.img).toBe("gravemire-stalker.png");
    expect(actor.prototypeToken?.texture?.src).toBe("gravemire-stalker.png");
  });

  it("creates items from abilities and actions", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    // Should have items for abilities and actions
    expect(actor.items.length).toBeGreaterThan(0);

    // Look for expected items
    const itemNames = actor.items.map((i) => i.name);
    expect(itemNames).toContain("Stench of the Grave");
    expect(itemNames).toContain("Multiattack");
    expect(itemNames).toContain("Claw");
  });

  it("only types actions with a parsed attack/save roll as weapon items", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const byName = (name: string) => actor.items.find((i) => i.name === name);

    // Multiattack and Grasp of the Mire have no attack roll/save - they're
    // descriptive features, matching the official compendium structure.
    expect(byName("Multiattack")?.type).toBe("feature");
    expect(byName("Grasp of the Mire")?.type).toBe("feature");

    // Claw and Grave Breath have parsed mechanics - they're weapons.
    expect(byName("Claw")?.type).toBe("weapon");
    expect(byName("Grave Breath")?.type).toBe("weapon");

    // Claw's attack bonus is positive (+5), formatted with a leading "+"
    const claw = byName("Claw");
    expect((claw?.system as Record<string, any>)?.attack?.bonus).toBe("+5");

    // Grave Breath's save DC and ability are persisted so the sheet can
    // prompt the correct saving throw
    const graveBreath = byName("Grave Breath");
    const graveBreathSystem = graveBreath?.system as Record<string, any>;
    expect(graveBreathSystem?.save?.ability).toBe("con");
    expect(graveBreathSystem?.save?.dc?.value).toBe(12);
  });

  it("formats a negative attack bonus without a doubled sign", () => {
    const markdown = `\`\`\`statblock
name: Weakling
cr: 0
ac: 10
hp: 4
stats: [6, 10, 10, 10, 10, 10]
actions:
  - name: Feeble Jab
    desc: "Melee Attack Roll: -1, reach 5 ft. Hit: 1 bludgeoning damage."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const jab = actor.items.find((i) => i.name === "Feeble Jab");

    expect((jab?.system as Record<string, any>)?.attack?.bonus).toBe("-1");
  });

  it("assigns default icons per item type", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    for (const item of actor.items) {
      expect(item.img).toMatch(/^icons\/svg\//);
    }
  });
});
