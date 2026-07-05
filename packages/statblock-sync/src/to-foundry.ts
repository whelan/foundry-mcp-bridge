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
import { parseAttackAction, parseSaveAction } from "./grammar.js";

export interface Dnd5eActorDocument {
  name: string;
  type: "npc" | "character";
  img?: string;
  prototypeToken?: { texture?: { src?: string } };
  system: Record<string, unknown>;
  items: Dnd5eItem[];
  effects: unknown[];
}

export interface Dnd5eItem {
  name: string;
  type: string;
  img?: string;
  system?: Record<string, unknown>;
}

/**
 * Generic Foundry-core icons used as sensible defaults per item type.
 * These are bundled with Foundry itself (not the dnd5e system), so they're
 * always available regardless of which systems/modules are installed.
 * They are placeholders, not the artwork used by the official monster
 * compendium — matching that requires compendium item lookup (a later tier
 * of this feature, not part of grammar-only conversion).
 */
const DEFAULT_ITEM_ICONS: Record<string, string> = {
  feature: "icons/svg/book.svg",
  weapon: "icons/svg/sword.svg",
};

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
      alignment: statblock.frontMatter.alignment ?? statblock.creatureType.alignment,
      race: { value: statblock.frontMatter.race ?? "" },
      type: {
        value: statblock.creatureType.type,
        subtype: statblock.creatureType.subtype ?? "",
      },
      size: statblock.creatureType.size,
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
      img: DEFAULT_ITEM_ICONS.feature,
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

  const actorImg = statblock.frontMatter.image ?? undefined;
  return {
    name: statblock.frontMatter.name,
    type: "npc",
    img: actorImg,
    system,
    items,
    effects: [],
    prototypeToken: actorImg ? { texture: { src: actorImg } } : undefined,
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
 *
 * Whether an action becomes a rollable "weapon" item or a plain "feature"
 * item is decided by whether the grammar parser actually found an attack
 * roll or saving throw in its description — not by which section it came
 * from. Purely descriptive actions/reactions (e.g. "Multiattack", "Sudden
 * Lurch") have no mechanical roll and belong in the official compendium as
 * "feature" items even though they're under the Actions/Reactions headers.
 */
function actionToItem(action: StatblockData["actions"][0]): Dnd5eItem {
  const attackParsed = parseAttackAction(action.description);
  const saveParsed = parseSaveAction(action.description);
  const isMechanical = !!attackParsed || !!saveParsed;

  const item: Dnd5eItem = {
    name: action.name,
    type: isMechanical ? "weapon" : "feature",
    img: isMechanical ? DEFAULT_ITEM_ICONS.weapon : DEFAULT_ITEM_ICONS.feature,
    system: {
      description: { value: action.description },
      source: "",
    },
  };

  if (!isMechanical) return item;

  const system = item.system as Record<string, unknown>;
  system.damage = { parts: [] };
  system.attack = { bonus: "" };
  system.range = { value: null, long: null, units: "ft" };

  if (attackParsed) {
    system.type = attackParsed.type === "ranged" ? "rangedW" : "meleeM";
    system.attack = { bonus: `+${attackParsed.bonus}` };
    system.damage = {
      parts: attackParsed.damage.map((d) => [d.formula, d.type]),
    };
    if (attackParsed.reach) {
      (system.range as Record<string, unknown>).value = attackParsed.reach;
    } else if (attackParsed.range) {
      (system.range as Record<string, unknown>).value = attackParsed.range.normal;
      (system.range as Record<string, unknown>).long = attackParsed.range.long ?? null;
    }
  } else if (saveParsed) {
    system.type = "spellcasting";
    system.damage = {
      parts: saveParsed.damage.map((d) => [d.formula, d.type]),
    };
  }

  if (action.recharge) {
    system.recharge = action.recharge;
  }

  return item;
}
