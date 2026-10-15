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

  it("sets movement from the parsed speed (strings — dnd5e coerces numbers on write)", () => {
    const system = gravemireActor.system as Record<string, any>;
    expect(system.attributes.movement.speeds.walk).toBe("30");
    expect(system.attributes.movement.speeds.swim).toBe("20");
    expect(system.attributes.movement.units).toBe("ft");
    // dnd5e 6.0 migrates the flat movement.walk away and never stores it.
    expect(system.attributes.movement.walk).toBeUndefined();
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
    expect(system.attributes.movement.speeds).toEqual({});
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

  it("assigns Foundry-core icons: named artwork for known monster items, svg fallback otherwise", () => {
    for (const item of gravemireActor.items) {
      // Everything ships a Foundry-core icon path (always present, any install)
      expect(item.img).toMatch(/^icons\//);
    }
    const byName = (n: string) => gravemireActor.items.find((i) => i.name === n)!;
    // Common monster attacks get the same artwork the official 2024 monsters use
    expect(byName("Claw").img).toBe("icons/skills/melee/blood-slash-foam-red.webp");
    expect(byName("Multiattack").img).toBe("icons/skills/melee/strike-weapons-orange.webp");
    expect(byName("Grave Breath").img).toBe("icons/creatures/abilities/dragon-breath-purple.webp");
    // No named match → per-type svg fallback
    expect(byName("Stench of the Grave").img).toBe("icons/svg/book.svg");
    expect(byName("Grasp of the Mire").img).toBe("icons/svg/book.svg");
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

describe("modern dnd5e actor system shapes (6.0.5)", () => {
  const sys = gravemireActor.system as Record<string, any>;

  it("puts senses under attributes.senses.ranges and never emits passive Perception", () => {
    expect(sys.attributes.senses).toEqual({
      units: null,
      special: "",
      ranges: { darkvision: 60, blindsight: null, tremorsense: null, truesight: null },
    });
  });

  it("uses natural-armor AC calcs when the statblock says so", () => {
    // gravemire-stalker.md: "ac: 14 (natural armor)". dnd5e 6.0.5 does not store ac.calc
    // (derived, not persisted), so the natural calc is calcs ["natural"] with the value in flat.
    expect(sys.attributes.ac).toEqual({ flat: 14, calcs: ["natural"] });
    expect(sys.attributes.ac.calc).toBeUndefined();
  });

  it("uses a fixed AC override for any other stated AC", () => {
    // The system's own migration turns the old calc "flat" into override = flat.
    const sb = parseStatblock("```statblock\nname: Plain\ncr: 1\nac: 12\nac_class: leather armor\nhp: 10\nspeed: 30 ft.\nstats: [10, 10, 10, 10, 10, 10]\n```\n");
    const a = statblockToFoundryActor(sb).system as Record<string, any>;
    expect(a.attributes.ac).toEqual({ flat: 12, override: 12 });
    expect(a.attributes.ac.calc).toBeUndefined();
  });

  it("puts a skill or save delta in roll.bonus (dnd5e 6.0 moved it from bonuses.*)", () => {
    // DEX 14 (+2), CR 1 (prof +2): Stealth +6 is a +2 delta over proficiency; DEX save +5 is +1 over it.
    const sb = parseStatblock("```statblock\nname: Sneaky\ncr: 1\nac: 12\nhp: 10\nspeed: 30 ft.\nstats: [10, 14, 10, 10, 10, 10]\nsaves:\n  - dexterity: 5\nskillsaves:\n  - stealth: 6\n```\n");
    const a = statblockToFoundryActor(sb).system as Record<string, any>;
    expect(a.skills.ste).toEqual({ value: 1, ability: "dex", roll: { bonus: "2" } });
    expect(a.skills.ste.bonuses).toBeUndefined();
    expect(a.abilities.dex.save).toEqual({ roll: { bonus: "1" } });
    expect(a.abilities.dex.bonuses).toBeUndefined();
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

  it("emits skill proficiencies as multipliers with an explicit ability", () => {
    // Stealth +4 = dex +2 + prof +2 → multiplier 1, no delta.
    // ability must be written: dnd5e's SkillData default is not per-skill, so
    // omitting it made Perception roll off DEX (+4 instead of +3, found live in M6b).
    expect(sys.skills.ste).toEqual({ value: 1, ability: "dex" });
    // Perception +3 = wis +1 + prof +2 → multiplier 1, no delta
    expect(sys.skills.prc).toEqual({ value: 1, ability: "wis" });
  });

  it("emits save proficiencies on abilities.<abl>.proficient", () => {
    // WIS save +3 = wis +1 + prof +2 → proficient, no delta
    expect(sys.abilities.wis).toEqual({ value: 12, proficient: 1 });
    expect(sys.abilities.str).toEqual({ value: 16 });
  });

  it("emits only the speeds the statblock defines", () => {
    // gravemire-stalker.md: "speed: 30 ft., swim 20 ft." — no climb: 0 noise.
    // String values: dnd5e stores speeds as strings (read-back verify
    // fails on numeric 30 vs "30"; found live in M6a), under movement.speeds since 6.0.
    expect(sys.attributes.movement).toEqual({ speeds: { walk: "30", swim: "20" }, units: "ft", hover: false });
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

  it("computes onSave 'half' from the flowing 'or half as much on a successful save' phrasing (no 'Success:' label)", () => {
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

  it("sets resources.legact.max from the count of legendary_actions entries", () => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
legendary_actions:
  - name: Detect
    desc: "The dragon makes a Wisdom (Perception) check."
  - name: Tail Attack
    desc: "Melee Attack Roll: +8, reach 15 ft. Hit: 13 (2d6 + 4) Bludgeoning damage."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.resources.legact.max).toBe(2);
    expect(system.resources.legact.spent).toBe(0);
  });

  it("honors an explicit legendary_action_count override instead of counting entries", () => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
legendary_action_count: 3
legendary_actions:
  - name: Detect
    desc: "The dragon makes a Wisdom (Perception) check."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.resources.legact.max).toBe(3);
  });

  it("sets resources.legres.max and a daily-recovery uses block from a Legendary Resistance trait", () => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
traits:
  - name: Legendary Resistance (3/Day)
    desc: "If the dragon fails a saving throw, it can choose to succeed instead."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.resources.legres.max).toBe(3);
    expect(system.resources.legres.spent).toBe(0);

    const legres = actor.items.find((i) => i.name === "Legendary Resistance")!;
    expect((legres.system as Record<string, any>).uses).toEqual({
      spent: 0,
      max: "3",
      recovery: [{ period: "day", formula: "", type: "recoverAll" }],
    });
  });

  it("sets resources.lair.initiative to 20 when lair_actions are present, else null", () => {
    const withLair = parseStatblock(`\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
lair_actions:
  - name: Volcanic Fissure
    desc: "Dexterity Saving Throw: DC 16, each creature standing in the new fissure. Failure: 10 (3d6) Fire damage."
\`\`\`
`);
    const actorWithLair = statblockToFoundryActor(withLair);
    expect((actorWithLair.system as Record<string, any>).resources.lair).toEqual({
      value: true,
      initiative: 20,
      inside: false,
    });

    const withoutLair = parseStatblock(`\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
\`\`\`
`);
    const actorWithoutLair = statblockToFoundryActor(withoutLair);
    expect((actorWithoutLair.system as Record<string, any>).resources.lair).toEqual({
      value: false,
      initiative: null,
      inside: false,
    });
  });

  it("sets attributes.spellcasting and spells.spellN.{value,override} from statblock.spellcasting", () => {
    const markdown = `\`\`\`statblock
name: Test Archmage
cr: 12
ac: 12
hp: 100
stats: [10, 14, 12, 20, 15, 16]
traits:
  - name: Spellcasting
    desc: "The archmage is a level 18 spellcaster. Its spellcasting ability is Intelligence (spell save DC 17, +9 to hit with spell attacks). The archmage has the following wizard spells prepared: Cantrips (at will): fire bolt, light 1st level (4 slots): detect magic, shield 2nd level (3 slots): misty step, suggestion"
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;

    expect(system.attributes.spellcasting).toBe("int");
    expect(system.spells.spell1).toEqual({ value: 4, override: 4 });
    expect(system.spells.spell2).toEqual({ value: 3, override: 3 });
    expect(system.spells.spell0).toBeUndefined();
  });

  it("omits spellcasting fields entirely for a non-caster", () => {
    const statblock = parseStatblock(`\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
\`\`\`
`);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.attributes.spellcasting).toBeUndefined();
    expect(system.spells).toBeUndefined();
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

  it("makes a 2024 header-form lair-action save a mechanical save with lair activation", () => {
    const markdown = `\`\`\`statblock
name: Test Lair Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
lair_actions:
  - name: Grasping Roots
    desc: "Strength Saving Throw: DC 18, each creature in a 20-foot-radius sphere. Failure: The creature is restrained."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const roots = actor.items.find((i) => i.name === "Grasping Roots")!;
    const act = Object.values((roots.system as Record<string, any>).activities)[0] as any;

    expect(act.type).toBe("save");
    expect(act.save).toEqual({ ability: ["str"], dc: { calculation: "", formula: "18" } });
    expect(act.activation.type).toBe("lair");
  });

  it("leaves a 2014-style 'Weapon Attack: +N to hit' action as a description-only feat (2024-only converter)", () => {
    // 2024-only: 2014 attack grammar must NOT be treated as a rollable attack.
    // It falls through to a plain feat so it's visibly non-mechanical rather
    // than silently mis-converted.
    const markdown = `\`\`\`statblock
name: Test 2014 Bandit
cr: 1
ac: 12
hp: 20
stats: [12, 14, 12, 10, 10, 10]
actions:
  - name: Scimitar
    desc: "Melee Weapon Attack: +3 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const scimitar = actor.items.find((i) => i.name === "Scimitar")!;

    expect(scimitar.type).toBe("feat");
    const act = Object.values((scimitar.system as Record<string, any>).activities)[0] as any;
    expect(act.type).toBe("utility");
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
