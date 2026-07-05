/**
 * M2 Tests: 5e math derivation (ability modifiers, proficiency, damage)
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseStatblock,
  getAbilityModifier,
  getProficiencyBonus,
  parseDamageFormula,
  deriveSkillBonus,
  deriveSaveBonus,
  derivePlainStatblockStats,
} from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("M2: 5e Math Derivation", () => {
  describe("Ability modifiers", () => {
    it("computes ability modifier from score", () => {
      expect(getAbilityModifier(10)).toBe(0);
      expect(getAbilityModifier(11)).toBe(0);
      expect(getAbilityModifier(12)).toBe(1);
      expect(getAbilityModifier(14)).toBe(2);
      expect(getAbilityModifier(16)).toBe(3);
      expect(getAbilityModifier(18)).toBe(4);
      expect(getAbilityModifier(20)).toBe(5);
      expect(getAbilityModifier(8)).toBe(-1);
      expect(getAbilityModifier(6)).toBe(-2);
    });
  });

  describe("Proficiency bonus", () => {
    it("computes proficiency bonus from CR", () => {
      // Standard progression: +2 for CR < 5, +3 for CR 5-8, etc.
      expect(getProficiencyBonus(0)).toBe(2);
      expect(getProficiencyBonus(0.5)).toBe(2);
      expect(getProficiencyBonus(1)).toBe(2);
      expect(getProficiencyBonus(4)).toBe(2);
      expect(getProficiencyBonus(5)).toBe(3);
      expect(getProficiencyBonus(8)).toBe(3);
      expect(getProficiencyBonus(9)).toBe(4);
      expect(getProficiencyBonus(12)).toBe(4);
      expect(getProficiencyBonus(13)).toBe(5);
      expect(getProficiencyBonus(16)).toBe(5);
      expect(getProficiencyBonus(17)).toBe(6);
      expect(getProficiencyBonus(20)).toBe(6);
      expect(getProficiencyBonus(21)).toBe(7);
      expect(getProficiencyBonus(25)).toBe(8);
      expect(getProficiencyBonus(29)).toBe(9);
    });
  });

  describe("Damage formula parsing", () => {
    it("parses simple dice formulas", () => {
      const formula1 = parseDamageFormula("2d6");
      expect(formula1.count).toBe(2);
      expect(formula1.die).toBe(6);
      expect(formula1.bonus).toBe(0);
      expect(formula1.average).toBe(7); // (6+1)/2 * 2 = 7

      const formula2 = parseDamageFormula("4d10");
      expect(formula2.count).toBe(4);
      expect(formula2.die).toBe(10);
      expect(formula2.bonus).toBe(0);
      expect(formula2.average).toBe(22); // (10+1)/2 * 4 = 22
    });

    it("parses formulas with bonus", () => {
      const formula1 = parseDamageFormula("2d6 + 3");
      expect(formula1.count).toBe(2);
      expect(formula1.die).toBe(6);
      expect(formula1.bonus).toBe(3);
      expect(formula1.average).toBe(10); // 7 + 3

      const formula2 = parseDamageFormula("1d8+2");
      expect(formula2.count).toBe(1);
      expect(formula2.die).toBe(8);
      expect(formula2.bonus).toBe(2);
      expect(formula2.average).toBe(6.5); // (8+1)/2 + 2 = 6.5
    });

    it("parses formulas with subtraction", () => {
      const formula = parseDamageFormula("2d6 - 1");
      expect(formula.count).toBe(2);
      expect(formula.bonus).toBe(-1);
      expect(formula.average).toBe(6); // 7 - 1
    });

    it("handles case-insensitive formulas", () => {
      const formula = parseDamageFormula("2D6 + 3");
      expect(formula.count).toBe(2);
      expect(formula.die).toBe(6);
      expect(formula.bonus).toBe(3);
    });
  });

  describe("Skill and save bonuses", () => {
    it("derives skill bonus from ability and proficiency", () => {
      // Ability modifier +3, not proficient
      expect(deriveSkillBonus(3, false, 2)).toBe(3);

      // Ability modifier +2, proficient with +2 bonus
      expect(deriveSkillBonus(2, true, 2)).toBe(4);

      // Ability modifier -1, not proficient
      expect(deriveSkillBonus(-1, false, 2)).toBe(-1);

      // Ability modifier -1, proficient with +3 bonus
      expect(deriveSkillBonus(-1, true, 3)).toBe(2);
    });

    it("derives save bonus the same way", () => {
      expect(deriveSaveBonus(3, false, 2)).toBe(3);
      expect(deriveSaveBonus(2, true, 2)).toBe(4);
    });
  });

  describe("Full statblock math derivation", () => {
    it("derives all stats from Gravemire Stalker", () => {
      const filePath = path.join(
        __dirname,
        "..",
        "fixtures",
        "statblock-import",
        "gravemire-stalker.md"
      );
      const raw = fs.readFileSync(filePath, "utf-8");
      const statblock = parseStatblock(raw);

      const derived = derivePlainStatblockStats(statblock);

      // Verify ability modifiers
      expect(derived.abilityModifiers.str).toBe(3); // 16
      expect(derived.abilityModifiers.dex).toBe(2); // 14
      expect(derived.abilityModifiers.con).toBe(2); // 14
      expect(derived.abilityModifiers.int).toBe(-1); // 9
      expect(derived.abilityModifiers.wis).toBe(0); // 11
      expect(derived.abilityModifiers.cha).toBe(-1); // 8

      // Proficiency bonus for CR 3 is 2
      expect(derived.proficiencyBonus).toBe(2);

      // Skill bonuses (from parsed skills)
      expect(derived.skillBonuses["Perception"]).toBe(2); // Wis mod (0) + proficiency (2)
      expect(derived.skillBonuses["Stealth"]).toBe(4); // Dex mod (2) + proficiency (2)

      // Saving throws
      expect(derived.saveBonuses["Wis"]).toBe(2); // Wis mod (0) + proficiency (2)
      expect(derived.saveBonuses["Cha"]).toBe(1); // Cha mod (-1) + proficiency (2)
    });
  });

  describe("Gravemire Stalker specific math", () => {
    it("verifies all derived mechanics match expected values", () => {
      const filePath = path.join(
        __dirname,
        "..",
        "fixtures",
        "statblock-import",
        "gravemire-stalker.md"
      );
      const raw = fs.readFileSync(filePath, "utf-8");
      const statblock = parseStatblock(raw);
      const derived = derivePlainStatblockStats(statblock);

      // Ability scores
      expect(statblock.abilities_.str).toBe(16);
      expect(statblock.abilities_.dex).toBe(14);
      expect(statblock.abilities_.con).toBe(14);

      // Modifiers from those scores
      expect(derived.abilityModifiers.str).toBe(3);
      expect(derived.abilityModifiers.dex).toBe(2);
      expect(derived.abilityModifiers.con).toBe(2);

      // CR 3 = proficiency +2
      expect(statblock.challenge.cr).toBe(3);
      expect(derived.proficiencyBonus).toBe(2);

      // AC and HP
      expect(statblock.attributes.armorClass).toBe(15);
      expect(statblock.attributes.hitPoints.value).toBe(52);

      // Hit dice formula
      expect(statblock.attributes.hitPoints.formula).toMatch(/8d8/);
    });
  });
});
