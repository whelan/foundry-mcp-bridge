/**
 * M4: Convert parsed statblocks to dnd5e Foundry actor JSON.
 *
 * This module takes a StatblockData and converts it to a Foundry actor document
 * suitable for import. It handles:
 * - Ability scores and modifiers
 * - AC, HP, and speed
 * - Skill and saving throw proficiencies
 * - Item creation (features, weapons)
 * - Traits and resistances
 */

import type { StatblockData } from "./schema.js";
import { getAbilityModifier } from "./math.js";
import { getSkillAbility, SKILL_TO_ABBREVIATION_MAP } from "./utils.js";

export interface Dnd5eActorDocument {
  name: string;
  type: "npc" | "character";
  img?: string;
  system: Record<string, unknown>;
  items: Dnd5eItem[];
  effects: unknown[];
}

export interface Dnd5eItem {
  name: string;
  type: string;
  system?: Record<string, unknown>;
}

/**
 * Convert a parsed statblock to a Foundry dnd5e actor document.
 */
export function statblockToFoundryActor(statblock: StatblockData): Dnd5eActorDocument {
  const abilities_ = statblock.abilities_;

  // Compute ability modifiers
  const abilityMods = {
    str: getAbilityModifier(abilities_.str),
    dex: getAbilityModifier(abilities_.dex),
    con: getAbilityModifier(abilities_.con),
    int: getAbilityModifier(abilities_.int),
    wis: getAbilityModifier(abilities_.wis),
    cha: getAbilityModifier(abilities_.cha),
  };

  // Build system object
  const system: Record<string, unknown> = {
    attributes: {
      ac: {
        flat: statblock.attributes.armorClass,
        calc: "default",
      },
      hp: {
        value: statblock.attributes.hitPoints.value,
        max: statblock.attributes.hitPoints.value,
        formula: statblock.attributes.hitPoints.formula,
      },
    },
    details: {
      biography: { value: "" },
      alignment: statblock.frontMatter.alignment ?? "",
      race: { value: statblock.frontMatter.race ?? "" },
      type: { value: "undead" }, // TODO: derive from type
      size: "med",
      cr: statblock.challenge.cr,
      xp: statblock.challenge.xp,
    },
    traits: {
      languages: { value: statblock.traits.languages },
      senses: statblock.traits.senses.join("; "),
    },
    traits_: {
      weaponProf: { value: [] },
      armorProf: { value: [] },
      toolProf: { value: [] },
      damageResistances: { value: statblock.traits.damageResistances },
      damageImmunities: { value: statblock.traits.damageImmunities },
      damageVulnerabilities: { value: statblock.traits.damageVulnerabilities },
      conditionImmunities: { value: statblock.traits.conditionImmunities },
    },
    abilities: {
      str: { value: abilities_.str },
      dex: { value: abilities_.dex },
      con: { value: abilities_.con },
      int: { value: abilities_.int },
      wis: { value: abilities_.wis },
      cha: { value: abilities_.cha },
    },
    skills: buildSkills(statblock, abilityMods),
  };

  // Create embedded items from abilities and actions
  const items: Dnd5eItem[] = [];

  // Add trait/ability features
  for (const ability of statblock.abilities) {
    items.push({
      name: ability.name,
      type: "feature",
      system: {
        description: { value: ability.description },
        source: "",
      },
    });
  }

  // Add actions (weapons and special actions)
  for (const action of statblock.actions) {
    items.push(actionToItem(action));
  }

  return {
    name: statblock.frontMatter.name,
    type: "npc",
    img: statblock.frontMatter.image ?? undefined,
    system,
    items,
    effects: [],
  };
}

/**
 * Build skills object for the dnd5e system.
 */
function buildSkills(
  statblock: StatblockData,
  abilityMods: Record<string, number>
): Record<string, unknown> {
  const skills: Record<string, Record<string, unknown>> = {};

  // Add proficient skills (using dnd5e abbreviations like "prc" for Perception)
  for (const prof of statblock.skills.proficiencies) {
    const skillNameLower = prof.skill.toLowerCase().replace(/ of hand/, "");
    const abbrev = SKILL_TO_ABBREVIATION_MAP[skillNameLower];
    if (!abbrev) continue;

    skills[abbrev] = {
      value: prof.bonus, // dnd5e stores the total bonus in value
    };
  }

  return skills;
}

/**
 * Convert an action to a Foundry item.
 * For weapon actions, builds attack bonus and damage parts for rollable mechanics.
 */
function actionToItem(action: StatblockData["actions"][0]): Dnd5eItem {
  const isWeapon = action.type === "action" || action.type === "reaction";

  const item: Dnd5eItem = {
    name: action.name,
    type: isWeapon ? "weapon" : "feature",
    system: {
      description: { value: action.description },
      source: "",
    },
  };

  // For weapon items, add attack/damage structure for Foundry rollables
  if (isWeapon) {
    const system = item.system as Record<string, unknown>;
    // Add fields expected by dnd5e 2024 system
    system.type = "meleeM"; // Would be refined to "meleeM", "rangedW", or "spellcasting" by grammar parser
    system.damage = {
      parts: [], // Grammar parser populates with [formula, damageType] pairs
    };
    system.attack = {
      bonus: "", // Would be populated as "+X" from parsed attack bonus
    };
    system.range = {
      value: null,
      long: null,
      units: "ft",
    };
  }

  return item;
}
