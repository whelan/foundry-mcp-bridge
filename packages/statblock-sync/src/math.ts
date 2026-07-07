/**
 * M2: Derived 5e mechanics - ability modifiers, proficiency, skill/save bonuses, damage
 *
 * This module computes derived values from parsed ability scores and other stats.
 * It's the bridge between raw stat-block numbers and dnd5e's mechanical system.
 */

import type { StatblockData } from "./schema.js";
import { getSkillAbility } from "./utils.js";

/**
 * Compute ability modifier from ability score.
 * Formula: (score - 10) / 2, rounded down.
 */
export function getAbilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Get proficiency bonus for a given CR.
 * Standard D&D 5e Monster Manual progression: +2 for CR 0-4, +3 for CR 5-8,
 * +4 for CR 9-12, +5 for CR 13-16, +6 for CR 17-20, +7 for CR 21-24,
 * +8 for CR 25-28, +9 for CR 29+.
 */
export function getProficiencyBonus(cr: number): number {
  if (cr < 1) return 2;
  if (cr < 5) return 2;
  if (cr < 9) return 3;
  if (cr < 13) return 4;
  if (cr < 17) return 5;
  if (cr < 21) return 6;
  if (cr < 25) return 7;
  if (cr < 29) return 8;
  return 9;
}

/**
 * Parse average damage from a damage string like "2d6 + 3" or "4d10".
 * Returns { count, die, bonus, average }
 */
export interface DamageFormula {
  count: number;
  die: number;
  bonus: number;
  average: number; // (die + 1) / 2 * count + bonus
}

export function parseDamageFormula(formula: string): DamageFormula {
  const normalized = formula.toLowerCase().trim();

  // A pure flat number ("1", "3") — no dice at all, e.g. a low-CR statblock's
  // "Hit: 1 bludgeoning damage." count/die are 0 to signal "no dice component"
  // rather than falsely implying a die was rolled.
  const flatMatch = normalized.match(/^(\d+)$/);
  if (flatMatch && flatMatch[1]) {
    const bonus = parseInt(flatMatch[1], 10);
    return { count: 0, die: 0, bonus, average: bonus };
  }

  // Match patterns like "2d6", "4d10", "2d6+3", "2d6 + 3"
  const diceMatch = normalized.match(/(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?/);

  if (!diceMatch || !diceMatch[1] || !diceMatch[2]) {
    return {
      count: 1,
      die: 6,
      bonus: 0,
      average: 3.5,
    };
  }

  const count = parseInt(diceMatch[1], 10);
  const die = parseInt(diceMatch[2], 10);
  const sign = diceMatch[3] === "-" ? -1 : 1;
  const bonus = diceMatch[4] ? sign * parseInt(diceMatch[4], 10) : 0;

  // Average for a single die is (die + 1) / 2
  const average = ((die + 1) / 2) * count + bonus;

  return {
    count,
    die,
    bonus,
    average: Math.round(average * 10) / 10, // Round to 1 decimal place
  };
}

/**
 * Derive skill bonus from ability modifier and proficiency (if present).
 */
export function deriveSkillBonus(
  abilityMod: number,
  proficient: boolean,
  proficiencyBonus: number
): number {
  return abilityMod + (proficient ? proficiencyBonus : 0);
}

/**
 * Derive saving throw bonus from ability modifier and proficiency (if present).
 */
export function deriveSaveBonus(
  abilityMod: number,
  proficient: boolean,
  proficiencyBonus: number
): number {
  return abilityMod + (proficient ? proficiencyBonus : 0);
}

/**
 * Ability score shorthand mapping for convenience.
 */
export function getAbilityMod(abilities_: StatblockData["abilities_"], ability: string): number {
  const score = (abilities_ as Record<string, number>)[ability.toLowerCase()];
  // A real score of 0 is legitimate (some constructs/objects have it) and
  // must not be treated the same as an unknown ability key.
  return score !== undefined ? getAbilityModifier(score) : 0;
}

/**
 * All derived values computed from a statblock.
 */
export interface DerivedStats {
  abilityModifiers: Record<string, number>;
  proficiencyBonus: number;
  skillBonuses: Record<string, number>;
  saveBonuses: Record<string, number>;
  damageDerived: Record<string, DamageFormula>;
}

/**
 * Compute all derived stats from a parsed statblock.
 */
export function derivePlainStatblockStats(statblock: StatblockData): DerivedStats {
  const abilities_ = statblock.abilities_;
  const profBonus = getProficiencyBonus(statblock.challenge.cr);

  // Ability modifiers
  const abilityModifiers: Record<string, number> = {
    str: getAbilityModifier(abilities_.str),
    dex: getAbilityModifier(abilities_.dex),
    con: getAbilityModifier(abilities_.con),
    int: getAbilityModifier(abilities_.int),
    wis: getAbilityModifier(abilities_.wis),
    cha: getAbilityModifier(abilities_.cha),
  };

  // Skill bonuses (from statblock.skills.proficiencies)
  const skillBonuses: Record<string, number> = {};
  for (const prof of statblock.skills.proficiencies) {
    const skillAbility = skillToAbility(prof.skill);
    const baseMod = abilityModifiers[skillAbility] || 0;
    skillBonuses[prof.skill] = deriveSkillBonus(baseMod, prof.proficient, profBonus);
  }

  // Saving throw bonuses (from statblock.skills.savingThrows)
  const saveBonuses: Record<string, number> = {};
  for (const save of statblock.skills.savingThrows) {
    const abilityKey = save.ability.toLowerCase().substring(0, 3);
    const baseMod = abilityModifiers[abilityKey] || 0;
    saveBonuses[save.ability] = deriveSaveBonus(baseMod, save.proficient, profBonus);
  }

  // Damage formulas (parse from action descriptions later in M3)
  const damageDerived: Record<string, DamageFormula> = {};

  return {
    abilityModifiers,
    proficiencyBonus: profBonus,
    skillBonuses,
    saveBonuses,
    damageDerived,
  };
}

/**
 * Map skill name to primary ability score abbreviation.
 * Used for automatic skill bonus calculation.
 */
function skillToAbility(skill: string): string {
  return getSkillAbility(skill);
}
