/**
 * M1 Tests: Statblock parsing
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStatblock } from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("M1: Statblock Parsing", () => {
  it("parses Gravemire Stalker statblock from markdown", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");

    const statblock = parseStatblock(raw);

    // Verify front-matter
    expect(statblock.frontMatter.name).toBe("Gravemire Stalker");
    expect(statblock.frontMatter.type).toBe("npc");
    expect(statblock.frontMatter.cr).toBe(3);
    expect(statblock.frontMatter.image).toBe("gravemire-stalker.png");

    // Verify body exists
    expect(statblock.body).toContain("Armor Class");

    // Verify attributes
    expect(statblock.attributes.armorClass).toBe(15);
    expect(statblock.attributes.hitPoints.value).toBe(52);
    expect(statblock.attributes.hitPoints.formula).toBe("8d8 + 16");
    expect(statblock.attributes.speed.walk).toBe(30);

    // Verify ability scores
    expect(statblock.abilities_.str).toBe(16);
    expect(statblock.abilities_.dex).toBe(14);
    expect(statblock.abilities_.con).toBe(14);
    expect(statblock.abilities_.int).toBe(9);
    expect(statblock.abilities_.wis).toBe(11);
    expect(statblock.abilities_.cha).toBe(8);

    // Verify skills
    expect(statblock.skills.proficiencies.length).toBeGreaterThan(0);
    const perceptionSkill = statblock.skills.proficiencies.find(
      (s) => s.skill.toLowerCase() === "perception"
    );
    expect(perceptionSkill?.bonus).toBe(2);

    // Verify saving throws
    expect(statblock.skills.savingThrows.length).toBeGreaterThan(0);
    const wisSave = statblock.skills.savingThrows.find(
      (s) => s.ability.toLowerCase() === "wis"
    );
    expect(wisSave?.bonus).toBe(2);

    // Verify traits
    expect(statblock.traits.damageResistances).toContain("necrotic");
    expect(statblock.traits.senses.length).toBeGreaterThan(0);

    // Verify challenge
    expect(statblock.challenge.cr).toBe(3);
    expect(statblock.challenge.xp).toBe(700);

    // Verify creature type descriptor line ("*Medium undead, chaotic evil*")
    expect(statblock.creatureType.size).toBe("med");
    expect(statblock.creatureType.type).toBe("undead");
    expect(statblock.creatureType.alignment).toBe("chaotic evil");

    // Verify abilities (traits)
    expect(statblock.abilities.length).toBeGreaterThan(0);
    const undeadFortitude = statblock.abilities.find(
      (a) => a.name.toLowerCase().includes("undead")
    );
    expect(undeadFortitude?.description).toContain(
      "Constitution saving throw"
    );

    // Verify actions
    expect(statblock.actions.length).toBeGreaterThan(0);
    const multiattack = statblock.actions.find((a) => a.multiattack);
    expect(multiattack?.name).toBe("Multiattack");

    const claw = statblock.actions.find((a) => a.name === "Rotting Claw");
    expect(claw?.type).toBe("action");
    expect(claw?.description).toContain("+5 to hit");

    const howl = statblock.actions.find((a) => a.name === "Wailing Howl");
    // Recharge 5-6 means recharge on 5 or 6 (parser captures first digit)
    expect(howl?.recharge?.value).toBe(5);
  });

  it("parses front-matter with various types", () => {
    const markdown = `---
name: Test Monster
type: creature
cr: 2
source: xge
image: test.png
---

# Test Monster

**Armor Class** 12
**Hit Points** 20 (4d8 + 4)
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.frontMatter.type).toBe("creature");
    expect(statblock.frontMatter.cr).toBe(2);
  });

  it("throws on markdown without required front-matter", () => {
    const markdown = `# Monster Name

**Armor Class** 10
**Hit Points** 10 (1d8 + 2)
`;

    // parseStatblock requires name and type in front-matter
    expect(() => parseStatblock(markdown)).toThrow();
  });

  it("parses ability scores correctly", () => {
    const markdown = `---
name: Test
type: npc
---

| STR | DEX | CON | INT | WIS | CHA |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 18 (+4) | 12 (+1) | 16 (+3) | 14 (+2) | 13 (+1) | 15 (+2) |
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.abilities_.str).toBe(18);
    expect(statblock.abilities_.dex).toBe(12);
    expect(statblock.abilities_.con).toBe(16);
  });

  it("extracts multiple skills", () => {
    const markdown = `---
name: Test
type: npc
---

**Skills** Acrobatics +4, Animal Handling +1, Arcana +2
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.skills.proficiencies.length).toBeGreaterThanOrEqual(3);
  });

  it("detects recharge for actions", () => {
    const markdown = `---
name: Test
type: npc
---

## Actions

**Breath Weapon** (Recharge 6). The creature breathes fire.
`;

    const statblock = parseStatblock(markdown);
    const breath = statblock.actions.find((a) =>
      a.name.toLowerCase().includes("breath")
    );
    expect(breath?.recharge?.value).toBe(6);
  });

  it("parses creature type with a subtype in parentheses", () => {
    const markdown = `---
name: Test
type: npc
---

*Large humanoid (goblinoid), lawful evil*

**Armor Class** 14
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.creatureType.size).toBe("lg");
    expect(statblock.creatureType.type).toBe("humanoid");
    expect(statblock.creatureType.subtype).toBe("goblinoid");
    expect(statblock.creatureType.alignment).toBe("lawful evil");
  });

  it("defaults creature type when no descriptor line is present", () => {
    const markdown = `---
name: Test
type: npc
---

**Armor Class** 10
`;

    const statblock = parseStatblock(markdown);
    expect(statblock.creatureType.size).toBe("med");
    expect(statblock.creatureType.type).toBe("humanoid");
    expect(statblock.creatureType.alignment).toBe("");
  });
});
