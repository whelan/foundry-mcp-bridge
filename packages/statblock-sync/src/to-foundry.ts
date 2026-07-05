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
    img: statblock.frontMatter.image ? `./assets/${statblock.frontMatter.image}` : undefined,
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

  // Initialize all skills with ability modifiers
  const skillMap: Record<string, string> = {
    acrobatics: "dex",
    "animal handling": "wis",
    arcana: "int",
    athletics: "str",
    deception: "cha",
    history: "int",
    insight: "wis",
    intimidation: "cha",
    investigation: "int",
    medicine: "wis",
    nature: "int",
    perception: "wis",
    performance: "cha",
    persuasion: "cha",
    religion: "int",
    sleight: "dex",
    stealth: "dex",
    survival: "wis",
  };

  // Add proficient skills
  for (const prof of statblock.skills.proficiencies) {
    const skillName = prof.skill.toLowerCase().replace(/ of hand/, "");
    const mod = skillMap[skillName] || "str";
    skills[skillName] = {
      ability: mod,
      bonus: prof.bonus,
      value: 1, // proficient
    };
  }

  return skills;
}

/**
 * Convert an action to a Foundry item.
 */
function actionToItem(action: StatblockData["actions"][0]): Dnd5eItem {
  return {
    name: action.name,
    type: action.type === "action" || action.type === "reaction" ? "weapon" : "feature",
    system: {
      description: { value: action.description },
      source: "",
    },
  };
}
