import { describe, it, expect } from "vitest";
import { lintStatblockNote } from "../src/lint.js";

describe("lintStatblockNote", () => {
  it("returns empty array for a clean 2024 statblock", () => {
    const markdown = `
# Test NPC

\`\`\`statblock
name: Test NPC
size: Medium
type: humanoid
alignment: Unaligned
ac: 12
hp: 22
stats: [10, 10, 10, 10, 10, 10]
cr: 1
traits:
  - name: Innate Spellcasting
    desc: "The NPC casts one of the following spells, requiring no material components and using Wisdom as the spellcasting ability."
\`\`\`
`;
    const findings = lintStatblockNote(markdown);
    expect(findings).toEqual([]);
  });

  it("detects 2014-style attack phrasing (Melee Weapon Attack)", () => {
    const markdown = `
# Bad Attack NPC

\`\`\`statblock
name: Bad Attack NPC
size: Medium
type: humanoid
alignment: Unaligned
ac: 12
hp: 22
stats: [10, 10, 10, 10, 10, 10]
cr: 1
traits:
  - name: Bad Attack
    desc: "Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 10 (1d8 + 2) damage."
\`\`\`
`;
    const findings = lintStatblockNote(markdown);
    expect(findings.length).toBeGreaterThan(0);
    const attackFinding = findings.find((f) => f.action === "Bad Attack");
    expect(attackFinding).toBeDefined();
    expect(attackFinding?.severity).toBe("FAIL");
    expect(attackFinding?.problem).toContain("attack");
  });

  it("detects 2014-style save phrasing (saving throw)", () => {
    const markdown = `
# Bad Save NPC

\`\`\`statblock
name: Bad Save NPC
size: Medium
type: humanoid
alignment: Unaligned
ac: 12
hp: 22
stats: [10, 10, 10, 10, 10, 10]
cr: 1
traits:
  - name: Bad Save
    desc: "Dexterity saving throw DC 14, each creature in a 15-foot radius. Hit: 10 (3d6) fire damage."
\`\`\`
`;
    const findings = lintStatblockNote(markdown);
    expect(findings.length).toBeGreaterThan(0);
    const saveFinding = findings.find((f) => f.action === "Bad Save");
    expect(saveFinding).toBeDefined();
    expect(saveFinding?.severity).toBe("FAIL");
    expect(saveFinding?.problem).toContain("save");
  });

  it("returns FAIL for schema parse errors", () => {
    const markdown = `
# Bad Schema

\`\`\`statblock
name: Bad Schema
size: InvalidSize
type: humanoid
stats: [10, 10, 10, 10, 10, 10]
cr: 1
\`\`\`
`;
    const findings = lintStatblockNote(markdown);
    const schemaFailure = findings.find((f) => f.severity === "FAIL");
    expect(schemaFailure).toBeDefined();
    expect(schemaFailure?.problem).toBeTruthy();
  });

  it("returns empty array for markdown with no statblock fence", () => {
    const markdown = "# Just a heading\n\nNo statblock here.";
    const findings = lintStatblockNote(markdown);
    expect(findings).toEqual([]);
  });
});
