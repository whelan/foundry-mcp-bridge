/**
 * M5 Tests: Mock end-to-end - parse, derive, convert, and verify
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseStatblock,
  getAbilityModifier,
  statblockToFoundryActor,
} from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Structured verification report for an imported NPC.
 * Used in M5 to validate the full conversion pipeline.
 */
interface VerificationReport {
  name: string;
  cr: number;
  xp: number;
  acVerified: boolean;
  hpVerified: boolean;
  abilityScoresVerified: boolean;
  skillsVerified: boolean;
  resistancesVerified: boolean;
  itemsCreated: number;
  errors: string[];
}

/**
 * Comprehensive end-to-end verification of the NPC import pipeline.
 */
function verifyImportedNpc(
  statblock: ReturnType<typeof parseStatblock>
): VerificationReport {
  const errors: string[] = [];
  const actor = statblockToFoundryActor(statblock);
  const system = actor.system as Record<string, any>;

  // Verify AC
  const acMatch = system.attributes.ac.flat === statblock.attributes.armorClass;
  if (!acMatch) {
    errors.push(
      `AC mismatch: expected ${statblock.attributes.armorClass}, got ${system.attributes.ac.flat}`
    );
  }

  // Verify HP
  const hpMatch = system.attributes.hp.value === statblock.attributes.hitPoints.value;
  if (!hpMatch) {
    errors.push(
      `HP mismatch: expected ${statblock.attributes.hitPoints.value}, got ${system.attributes.hp.value}`
    );
  }

  // Verify ability scores
  let abilityScoresOk = true;
  const abilityKeys = ["str", "dex", "con", "int", "wis", "cha"] as const;
  for (const key of abilityKeys) {
    const expected = (statblock.abilities_ as Record<string, number>)[key];
    const actual = (system.abilities as Record<string, any>)[key]?.value;
    if (expected !== actual) {
      errors.push(`${key.toUpperCase()} mismatch: expected ${expected}, got ${actual}`);
      abilityScoresOk = false;
    }
  }

  // Verify skills (at least some are present)
  const skillsPresent = Object.keys(system.skills || {}).length > 0;
  if (!skillsPresent && statblock.skills.proficiencies.length > 0) {
    errors.push("Skills not converted to system");
  }

  // Verify resistances (moved to system.traits_ in dnd5e structure)
  const resistancesMatch = statblock.traits.damageResistances.every((res) =>
    ((system.traits_ as Record<string, any>)?.damageResistances?.value || []).includes(res)
  );
  if (!resistancesMatch) {
    const actual = ((system.traits_ as Record<string, any>)?.damageResistances?.value || []) as string[];
    errors.push(
      `Resistances mismatch: ${statblock.traits.damageResistances.join(", ")} vs ${actual.join(", ")}`
    );
  }

  return {
    name: actor.name,
    cr: statblock.challenge.cr,
    xp: statblock.challenge.xp,
    acVerified: acMatch,
    hpVerified: hpMatch,
    abilityScoresVerified: abilityScoresOk,
    skillsVerified: skillsPresent || statblock.skills.proficiencies.length === 0,
    resistancesVerified: resistancesMatch,
    itemsCreated: actor.items.length,
    errors,
  };
}

describe("M5: End-to-End Mock Pipeline", () => {
  it("completes full pipeline: parse → derive → convert → verify", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");

    // Step 1: Parse (M1)
    const statblock = parseStatblock(raw);
    expect(statblock.frontMatter.name).toBe("Gravemire Stalker");

    // Step 2: Derive math (M2) - verify modifiers
    const strMod = getAbilityModifier(statblock.abilities_.str);
    expect(strMod).toBe(3);

    // Step 3: Convert to Foundry (M4)
    const actor = statblockToFoundryActor(statblock);
    expect(actor.name).toBe("Gravemire Stalker");
    expect(actor.type).toBe("npc");

    // Step 4: Verify (M5)
    const report = verifyImportedNpc(statblock);
    expect(report.name).toBe("Gravemire Stalker");
    expect(report.acVerified).toBe(true);
    expect(report.hpVerified).toBe(true);
    expect(report.abilityScoresVerified).toBe(true);
    expect(report.resistancesVerified).toBe(true);
    expect(report.errors.length).toBe(0);
  });

  it("generates clean verification report for Gravemire Stalker", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const report = verifyImportedNpc(statblock);

    // All verifications should pass
    expect(report.acVerified).toBe(true);
    expect(report.hpVerified).toBe(true);
    expect(report.abilityScoresVerified).toBe(true);
    expect(report.resistancesVerified).toBe(true);
    expect(report.errors.length).toBe(0);

    // Items should be created
    expect(report.itemsCreated).toBeGreaterThan(0);
  });

  it("correctly computes derived values through the pipeline", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);

    // Verify CR and XP were correctly parsed and computed
    expect(statblock.challenge.cr).toBe(3);
    expect(statblock.challenge.xp).toBe(700); // CR 3 = 700 XP

    // Verify ability scores
    expect(statblock.abilities_.str).toBe(16);
    expect(statblock.abilities_.dex).toBe(14);
    expect(statblock.abilities_.con).toBe(14);

    // Verify derived modifiers
    expect(getAbilityModifier(16)).toBe(3);
    expect(getAbilityModifier(14)).toBe(2);
    expect(getAbilityModifier(9)).toBe(-1);
  });

  it("preserves all critical attributes through conversion", () => {
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

    // Critical attributes that must be preserved
    expect(actor.name).toBe(statblock.frontMatter.name);
    expect(system.attributes.ac.flat).toBe(statblock.attributes.armorClass);
    expect(system.attributes.hp.value).toBe(statblock.attributes.hitPoints.value);
    expect(system.details.cr).toBe(statblock.challenge.cr);
    expect(system.details.xp).toBe(statblock.challenge.xp);

    // Ability scores
    expect(system.abilities.str.value).toBe(statblock.abilities_.str);
    expect(system.abilities.dex.value).toBe(statblock.abilities_.dex);
    expect(system.abilities.con.value).toBe(statblock.abilities_.con);
  });
});
