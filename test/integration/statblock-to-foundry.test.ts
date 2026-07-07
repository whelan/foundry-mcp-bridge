/**
 * M4 Tests: Convert to Foundry dnd5e actor JSON
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStatblock, statblockToFoundryActor } from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GRAVEMIRE_PATH = path.join(__dirname, "..", "fixtures", "statblock-import", "gravemire-stalker.md");
const gravemireStatblock = parseStatblock(fs.readFileSync(GRAVEMIRE_PATH, "utf-8"));
const gravemireActor = statblockToFoundryActor(gravemireStatblock);

describe("M4: Convert to Foundry dnd5e Actor", () => {
  it("creates valid actor document from statblock", () => {
    // Verify basic structure
    expect(gravemireActor.name).toBe("Gravemire Stalker");
    expect(gravemireActor.type).toBe("npc");
    expect(gravemireActor.system).toBeDefined();
    expect(gravemireActor.items).toBeDefined();
    expect(gravemireActor.effects).toBeDefined();
  });

  it("sets correct ability scores", () => {
    const system = gravemireActor.system as Record<string, any>;
    expect(system.abilities.str.value).toBe(16);
    expect(system.abilities.dex.value).toBe(14);
    expect(system.abilities.con.value).toBe(15);
    expect(system.abilities.int.value).toBe(6);
    expect(system.abilities.wis.value).toBe(12);
    expect(system.abilities.cha.value).toBe(8);
  });

  it("sets correct AC and HP", () => {
    const system = gravemireActor.system as Record<string, any>;
    expect(system.attributes.ac.flat).toBe(14);
    expect(system.attributes.hp.value).toBe(45);
    expect(system.attributes.hp.max).toBe(45);
    expect(system.attributes.hp.formula).toBe("7d8+14");
  });

  it("sets movement from the parsed speed", () => {
    const system = gravemireActor.system as Record<string, any>;
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

    // Officials omit absent speeds entirely rather than emitting walk: 0.
    const system = actor.system as Record<string, any>;
    expect(system.attributes.movement.walk).toBeUndefined();
  });

  it("sets CR (XP is not an NPC field; dnd5e derives it from CR)", () => {
    const system = gravemireActor.system as Record<string, any>;
    expect(system.details.cr).toBe(3);
    expect(system.details.xp).toBeUndefined();
  });

  it("includes traits and resistances", () => {
    const system = gravemireActor.system as Record<string, any>;
    expect(system.traits.dr.value).toContain("necrotic");
    expect(system.attributes.senses.ranges.darkvision).toBe(60);
  });

  it("sets creature type, size, and alignment from the descriptor line", () => {
    const system = gravemireActor.system as Record<string, any>;
    expect(system.details.type.value).toBe("undead");
    expect(system.traits.size).toBe("med");
    expect(system.details.alignment).toBe("Neutral Evil");
  });

  it("sets prototypeToken texture to match the actor image", () => {
    expect(gravemireActor.img).toBe("gravemire-stalker.png");
    expect(gravemireActor.prototypeToken?.texture?.src).toBe("gravemire-stalker.png");
  });

  it("creates items from abilities and actions", () => {
    // Should have items for abilities and actions
    expect(gravemireActor.items.length).toBeGreaterThan(0);

    // Look for expected items
    const itemNames = gravemireActor.items.map((i) => i.name);
    expect(itemNames).toContain("Stench of the Grave");
    expect(itemNames).toContain("Multiattack");
    expect(itemNames).toContain("Claw");
  });

  it("only types actions with a parsed attack roll as weapons; save/descriptive actions are feats", () => {
    const byName = (name: string) => gravemireActor.items.find((i) => i.name === name);
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
    for (const item of gravemireActor.items) {
      expect(item.img).toMatch(/^icons\/svg\//);
    }
  });
});

describe("modern dnd5e item shapes (5.3.3 Activities)", () => {
  const byName = (n: string) => gravemireActor.items.find((i) => i.name === n)!;

  it("never emits the invalid 'feature' item type", () => {
    for (const item of gravemireActor.items) {
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

describe("modern dnd5e actor system shapes (5.3.3)", () => {
  const sys = gravemireActor.system as Record<string, any>;

  it("puts senses under attributes.senses.ranges and never emits passive Perception", () => {
    expect(sys.attributes.senses).toEqual({
      units: null,
      special: "",
      ranges: { darkvision: 60, blindsight: null, tremorsense: null, truesight: null },
    });
  });

  it("uses natural-armor AC calc when the statblock says so", () => {
    // gravemire-stalker.md: "ac: 14 (natural armor)"
    expect(sys.attributes.ac).toEqual({ flat: 14, calc: "natural" });
  });

  it("emits damage/condition traits under traits.dr/di/dv/ci", () => {
    expect(sys.traits.dr).toEqual({ value: ["necrotic"], bypasses: [], custom: "" });
    expect(sys.traits.ci).toEqual({ value: ["charmed"], custom: "" });
    expect(sys.traits.di).toEqual({ value: [], bypasses: [], custom: "" });
    expect(sys.traits.dv).toEqual({ value: [], bypasses: [], custom: "" });
    expect(sys.traits_).toBeUndefined();
  });

  it("puts free-text languages in custom, size under traits", () => {
    // "understands Common but can't speak" is not a language key
    expect(sys.traits.languages).toEqual({
      value: [],
      custom: "understands Common but can't speak",
      communication: {},
    });
    expect(sys.traits.size).toBe("med");
    expect(sys.details.size).toBeUndefined();
  });

  it("emits skill proficiencies as multipliers, not totals", () => {
    // Stealth +4 = dex +2 + prof +2 → multiplier 1, no delta
    expect(sys.skills.ste).toEqual({ value: 1 });
    // Perception +3 = wis +1 + prof +2 → multiplier 1, no delta
    expect(sys.skills.prc).toEqual({ value: 1 });
  });

  it("emits save proficiencies on abilities.<abl>.proficient", () => {
    // WIS save +3 = wis +1 + prof +2 → proficient, no delta
    expect(sys.abilities.wis).toEqual({ value: 12, proficient: 1 });
    expect(sys.abilities.str).toEqual({ value: 16 });
  });

  it("emits only the speeds the statblock defines", () => {
    // gravemire-stalker.md: "speed: 30 ft., swim 20 ft." — no climb: 0 noise
    expect(sys.attributes.movement).toEqual({ walk: 30, swim: 20, units: "ft", hover: false });
  });

  it("does not emit details.race (LocalDocumentField) or details.xp (derived)", () => {
    expect(sys.details.race).toBeUndefined();
    expect(sys.details.xp).toBeUndefined();
  });
});

describe("edge cases", () => {
  it("preserves a sense's parenthetical qualifier instead of discarding it", () => {
    const markdown = `\`\`\`statblock
name: Test Ooze
cr: 4
ac: 12
hp: 50
stats: [12, 10, 16, 2, 8, 2]
senses: "tremorsense 60 ft. (blind beyond this radius), passive Perception 9"
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const senses = (actor.system as Record<string, any>).attributes.senses;

    expect(senses.ranges.tremorsense).toBe(60);
    expect(senses.special).toBe("blind beyond this radius");
  });

  it("keeps a qualified resistance clause ('from nonmagical attacks') as custom text, not an unconditional type", () => {
    const markdown = `\`\`\`statblock
name: Test Wight
cr: 3
ac: 14
hp: 45
stats: [15, 14, 15, 6, 13, 15]
damage_resistances: "bludgeoning, piercing, and slashing from nonmagical attacks"
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const dr = (actor.system as Record<string, any>).traits.dr;

    // Must NOT grant unconditional resistance to bludgeoning/piercing.
    expect(dr.value).toEqual([]);
    expect(dr.custom).toBe("bludgeoning, piercing, and slashing from nonmagical attacks");
  });

  it("still recognizes a plain, unqualified damage-type list", () => {
    const markdown = `\`\`\`statblock
name: Test Elemental
cr: 3
ac: 14
hp: 45
stats: [15, 14, 15, 6, 13, 15]
damage_resistances: "cold, fire"
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const dr = (actor.system as Record<string, any>).traits.dr;

    expect(dr.value).toEqual(["cold", "fire"]);
    expect(dr.custom).toBe("");
  });

  it("doesn't lose the last type of an Oxford-comma unqualified list into custom text", () => {
    const markdown = `\`\`\`statblock
name: Test Elemental
cr: 3
ac: 14
hp: 45
stats: [15, 14, 15, 6, 13, 15]
damage_resistances: "cold, fire, and lightning"
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const dr = (actor.system as Record<string, any>).traits.dr;

    expect(dr.value).toEqual(["cold", "fire", "lightning"]);
    expect(dr.custom).toBe("");
  });

  it("converts flat (non-dice) damage instead of dropping it", () => {
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
    const jab = actor.items.find((i) => i.name === "Feeble Jab")!;
    const base = (jab.system as Record<string, any>).damage.base;

    expect(base).toMatchObject({ number: 0, denomination: 0, bonus: "1", types: ["bludgeoning"] });
  });

  it("computes onSave 'half' from the classic 2014-style phrasing (no 'Success:' label)", () => {
    const markdown = `\`\`\`statblock
name: Classic Breather
cr: 5
ac: 14
hp: 60
stats: [10, 10, 15, 10, 10, 10]
actions:
  - name: Poison Breath (Recharge 5-6)
    desc: "Constitution Saving Throw: DC 14, each creature in a 15-foot cone. Failure: 22 (4d10) Poison damage, or half as much damage on a successful save."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const breath = actor.items.find((i) => i.name === "Poison Breath")!;
    const act = Object.values((breath.system as Record<string, any>).activities)[0] as any;

    expect(act.damage.onSave).toBe("half");
  });

  it("wires recharge consumption on a recharge-limited attack (not just save actions)", () => {
    const markdown = `\`\`\`statblock
name: Recharge Biter
cr: 5
ac: 14
hp: 60
stats: [16, 10, 15, 10, 10, 10]
actions:
  - name: Vicious Bite (Recharge 5-6)
    desc: "Melee Attack Roll: +7, reach 5 ft. Hit: 18 (4d6 + 4) piercing damage."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const bite = actor.items.find((i) => i.name === "Vicious Bite")!;
    const sys = bite.system as Record<string, any>;

    expect(sys.uses).toEqual({
      spent: 0,
      max: "1",
      recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }],
    });
    const act = Object.values(sys.activities)[0] as any;
    expect(act.consumption.targets).toEqual([
      { type: "itemUses", value: "1", target: "", scaling: {} },
    ]);
  });

  it.each([
    ["legendary_actions", "legendary"],
    ["lair_actions", "lair"],
  ])("gives %s a %s activation, not a normal action-economy slot", (field, expectedType) => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
${field}:
  - name: Special Move
    desc: "The dragon does a special move."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const item = actor.items.find((i) => i.name === "Special Move")!;
    const act = Object.values((item.system as Record<string, any>).activities)[0] as any;

    expect(act.activation.type).toBe(expectedType);
  });

  it("keeps the recharge limiter on a purely-descriptive action whose description matches no attack/save grammar", () => {
    const markdown = `\`\`\`statblock
name: Test Roarer
cr: 5
ac: 14
hp: 60
stats: [16, 10, 15, 10, 10, 10]
actions:
  - name: Roar (Recharge 5-6)
    desc: "The creature lets out a terrifying roar."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const roar = actor.items.find((i) => i.name === "Roar")!;
    const sys = roar.system as Record<string, any>;

    expect(sys.uses).toEqual({
      spent: 0,
      max: "1",
      recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }],
    });
  });
});
