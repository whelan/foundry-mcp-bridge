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

  it("only types actions with a parsed attack roll as weapons; save/descriptive actions are feats", () => {
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
    const activityOfType = (item: ReturnType<typeof byName>, type: string): any =>
      Object.values((item?.system as Record<string, any>)?.activities ?? {}).find(
        (a: any) => a.type === type
      );

    // Multiattack and Grasp of the Mire have no attack roll/save - they're
    // descriptive feats, matching the official compendium structure.
    expect(byName("Multiattack")?.type).toBe("feat");
    expect(byName("Grasp of the Mire")?.type).toBe("feat");

    // Claw has a parsed attack roll - it's a weapon. Grave Breath has a
    // parsed save - it's a feat with a save activity.
    expect(byName("Claw")?.type).toBe("weapon");
    expect(byName("Grave Breath")?.type).toBe("feat");

    // Claw's attack activity carries the flat to-hit bonus (+5)
    const claw = byName("Claw");
    expect(activityOfType(claw, "attack")?.attack?.bonus).toBe("5");

    // Grave Breath's save activity carries the DC and ability so the sheet
    // can prompt the correct saving throw
    const graveBreath = byName("Grave Breath");
    const saveAct = activityOfType(graveBreath, "save");
    expect(saveAct?.save?.ability).toEqual(["con"]);
    expect(saveAct?.save?.dc?.formula).toBe("12");
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

    const act: any = Object.values((jab?.system as Record<string, any>)?.activities ?? {})[0];
    expect(act?.attack?.bonus).toBe("-1");
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

describe("modern dnd5e item shapes (5.3.3 Activities)", () => {
  const statblock = parseStatblock(
    fs.readFileSync("test/fixtures/statblock-import/gravemire-stalker.md", "utf-8"),
  );
  const actor = statblockToFoundryActor(statblock);
  const byName = (n: string) => actor.items.find((i) => i.name === n)!;

  it("never emits the invalid 'feature' item type", () => {
    for (const item of actor.items) {
      expect(["weapon", "feat"]).toContain(item.type);
    }
  });

  it("emits Claw as a natural weapon with structured base damage and a flat attack activity", () => {
    const claw = byName("Claw");
    expect(claw.type).toBe("weapon");
    const sys = claw.system as Record<string, any>;
    expect(sys.type).toEqual({ value: "natural", baseItem: "" });
    expect(sys.damage.base).toMatchObject({
      number: 1,
      denomination: 10,
      bonus: "3",
      types: ["slashing"],
    });
    const acts = Object.values(sys.activities as Record<string, any>);
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("attack");
    expect(acts[0].attack).toMatchObject({ flat: true, ability: "none", bonus: "5" });
    expect(acts[0].damage.includeBase).toBe(true);
    expect(acts[0].damage.parts).toHaveLength(1);
    expect(acts[0].damage.parts[0]).toMatchObject({
      number: 1,
      denomination: 6,
      types: ["necrotic"],
    });
    expect(sys.range).toMatchObject({ reach: 5, units: "ft" });
    // legacy fields must be gone
    expect(sys.attack).toBeUndefined();
    expect(sys.save).toBeUndefined();
    expect(sys.recharge).toBeUndefined();
  });

  it("emits Grave Breath as a feat with a save activity and recharge uses", () => {
    const breath = byName("Grave Breath");
    expect(breath.type).toBe("feat");
    const sys = breath.system as Record<string, any>;
    expect(sys.type).toEqual({ value: "monster", subtype: "" });
    expect(sys.uses).toEqual({
      spent: 0,
      max: "1",
      recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }],
    });
    const act = Object.values(sys.activities as Record<string, any>)[0];
    expect(act.type).toBe("save");
    expect(act.save).toEqual({ ability: ["con"], dc: { calculation: "", formula: "12" } });
    expect(act.damage.onSave).toBe("half");
    expect(act.damage.parts[0]).toMatchObject({ number: 4, denomination: 6, types: ["poison"] });
    expect(act.target.template).toMatchObject({ type: "cone", size: "15" });
    expect(act.consumption.targets).toEqual([
      { type: "itemUses", value: "1", target: "", scaling: {} },
    ]);
  });

  it("emits Multiattack as a feat with a utility activity", () => {
    const multi = byName("Multiattack");
    expect(multi.type).toBe("feat");
    const sys = multi.system as Record<string, any>;
    const act = Object.values(sys.activities as Record<string, any>)[0];
    expect(act.type).toBe("utility");
    expect(act.activation.type).toBe("action");
  });

  it("emits the reaction with reaction activation", () => {
    const grasp = byName("Grasp of the Mire");
    expect(grasp.type).toBe("feat");
    const act = Object.values((grasp.system as Record<string, any>).activities)[0] as any;
    expect(act.activation.type).toBe("reaction");
  });

  it("emits traits as feats flagged with the trait property and no activities", () => {
    const stench = byName("Stench of the Grave");
    expect(stench.type).toBe("feat");
    const sys = stench.system as Record<string, any>;
    expect(sys.type).toEqual({ value: "monster", subtype: "" });
    expect(sys.properties).toEqual(["trait"]);
    expect(sys.activities).toEqual({});
  });
});
