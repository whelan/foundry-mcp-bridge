/**
 * M1 Tests: Statblock parsing
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStatblock, parseStatblockRaw } from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("M1: Statblock Parsing", () => {
  it("parses Gravemire Stalker statblock from a ```statblock fence", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");

    const statblock = parseStatblock(raw);

    // Verify the raw fenced fields
    expect(statblock.data.name).toBe("Gravemire Stalker");
    expect(statblock.data.cr).toBe(3);
    expect(statblock.data.image).toBe("gravemire-stalker.png");

    // Verify prose surrounding the fence is preserved
    expect(statblock.prose.before).toContain("# Gravemire Stalker");
    expect(statblock.prose.after).toContain("restless thing");

    // Verify attributes
    expect(statblock.attributes.armorClass).toBe(14);
    expect(statblock.attributes.hitPoints.value).toBe(45);
    expect(statblock.attributes.hitPoints.formula).toBe("7d8+14");
    expect(statblock.attributes.speed.walk).toBe(30);
    expect(statblock.attributes.speed.swim).toBe(20);

    // Verify ability scores (stats: [16, 14, 15, 6, 12, 8])
    expect(statblock.abilities_.str).toBe(16);
    expect(statblock.abilities_.dex).toBe(14);
    expect(statblock.abilities_.con).toBe(15);
    expect(statblock.abilities_.int).toBe(6);
    expect(statblock.abilities_.wis).toBe(12);
    expect(statblock.abilities_.cha).toBe(8);

    // Verify skills
    expect(statblock.skills.proficiencies.length).toBe(2);
    const perceptionSkill = statblock.skills.proficiencies.find(
      (s) => s.skill.toLowerCase() === "perception"
    );
    expect(perceptionSkill?.bonus).toBe(3);

    // Verify saving throws
    expect(statblock.skills.savingThrows.length).toBe(1);
    const wisSave = statblock.skills.savingThrows.find(
      (s) => s.ability.toLowerCase() === "wisdom"
    );
    expect(wisSave?.bonus).toBe(3);

    // Verify traits
    expect(statblock.traits.damageResistances).toContain("necrotic");
    expect(statblock.traits.conditionImmunities).toContain("charmed");
    expect(statblock.traits.senses.length).toBeGreaterThan(0);

    // Verify challenge
    expect(statblock.challenge.cr).toBe(3);
    expect(statblock.challenge.xp).toBe(700);

    // Verify creature type
    expect(statblock.creatureType.size).toBe("med");
    expect(statblock.creatureType.type).toBe("undead");
    expect(statblock.creatureType.alignment).toBe("Neutral Evil");

    // Verify abilities (from the `traits` list)
    expect(statblock.abilities.length).toBe(1);
    expect(statblock.abilities[0]?.name).toBe("Stench of the Grave");
    expect(statblock.abilities[0]?.description).toContain(
      "Constitution saving throw"
    );

    // Verify actions
    expect(statblock.actions.length).toBe(4); // Multiattack, Claw, Grave Breath, Grasp of the Mire
    const multiattack = statblock.actions.find((a) => a.multiattack);
    expect(multiattack?.name).toBe("Multiattack");

    const claw = statblock.actions.find((a) => a.name === "Claw");
    expect(claw?.type).toBe("action");
    expect(claw?.description).toContain("+5");

    const breath = statblock.actions.find((a) => a.name === "Grave Breath");
    // Recharge suffix is stripped from the name and captured separately
    expect(breath?.recharge?.value).toBe(5);

    const reaction = statblock.actions.find((a) => a.name === "Grasp of the Mire");
    expect(reaction?.type).toBe("reaction");
  });

  it("parses cr and various fields from a minimal statblock", () => {
    const markdown = `\`\`\`statblock
name: Test Monster
cr: 2
ac: 12
hp: 20
hit_dice: 4d8+4
stats: [10, 10, 10, 10, 10, 10]
\`\`\`
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.data.cr).toBe(2);
    expect(statblock.attributes.armorClass).toBe(12);
    expect(statblock.attributes.hitPoints.value).toBe(20);
  });

  it("throws when the fence is missing required fields", () => {
    const markdown = `\`\`\`statblock
ac: 10
hp: 10
\`\`\`
`;

    // parseStatblock requires name, ac, hp, and stats
    expect(() => parseStatblock(markdown)).toThrow();
  });

  it("throws when there is no ```statblock fence at all", () => {
    const markdown = `# Monster Name

Just some prose, no fenced statblock here.
`;

    expect(() => parseStatblock(markdown)).toThrow();
  });

  it("does not assume a walk speed when the speed field is omitted", () => {
    const markdown = `\`\`\`statblock
name: Test
cr: 1
ac: 10
hp: 10
stats: [10, 10, 10, 10, 10, 10]
\`\`\`
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.attributes.speed.walk).toBeUndefined();
  });

  it("parses ability scores from the stats tuple", () => {
    const markdown = `\`\`\`statblock
name: Test
cr: 1
ac: 10
hp: 10
stats: [18, 12, 16, 14, 13, 15]
\`\`\`
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.abilities_.str).toBe(18);
    expect(statblock.abilities_.dex).toBe(12);
    expect(statblock.abilities_.con).toBe(16);
  });

  it("extracts multiple skills from skillsaves", () => {
    const markdown = `\`\`\`statblock
name: Test
cr: 1
ac: 10
hp: 10
stats: [10, 10, 10, 10, 10, 10]
skillsaves:
  - acrobatics: 4
  - animal handling: 1
  - arcana: 2
\`\`\`
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.skills.proficiencies.length).toBe(3);
  });

  it("detects and strips a recharge suffix from an action name", () => {
    const markdown = `\`\`\`statblock
name: Test
cr: 1
ac: 10
hp: 10
stats: [10, 10, 10, 10, 10, 10]
actions:
  - name: Breath Weapon (Recharge 6)
    desc: "The creature breathes fire."
\`\`\`
`;

    const statblock = parseStatblock(markdown);
    const breath = statblock.actions.find((a) => a.name === "Breath Weapon");
    expect(breath?.recharge?.value).toBe(6);
  });

  it("parses creature type with a subtype in parentheses", () => {
    const markdown = `\`\`\`statblock
name: Test
size: Large
type: humanoid (goblinoid)
alignment: lawful evil
cr: 1
ac: 14
hp: 10
stats: [10, 10, 10, 10, 10, 10]
\`\`\`
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.creatureType.size).toBe("lg");
    expect(statblock.creatureType.type).toBe("humanoid");
    expect(statblock.creatureType.subtype).toBe("goblinoid");
    expect(statblock.creatureType.alignment).toBe("lawful evil");
  });

  it("defaults creature type when size/type/alignment are omitted", () => {
    const markdown = `\`\`\`statblock
name: Test
cr: 1
ac: 10
hp: 10
stats: [10, 10, 10, 10, 10, 10]
\`\`\`
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.creatureType.size).toBe("med");
    expect(statblock.creatureType.type).toBe("humanoid");
    expect(statblock.creatureType.alignment).toBe("");
  });

  describe("parseStatblockRaw", () => {
    it("preserves prose before and after the fence", () => {
      const markdown = `Some intro prose.

\`\`\`statblock
name: Test
cr: 1
ac: 10
hp: 10
stats: [10, 10, 10, 10, 10, 10]
\`\`\`

Some trailing prose.
`;

      const { data, prose } = parseStatblockRaw(markdown);
      expect(data.name).toBe("Test");
      expect(prose.before).toContain("Some intro prose.");
      expect(prose.after).toContain("Some trailing prose.");
    });
  });
});
