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
import { SKILL_TO_ABBREVIATION_MAP } from "./utils.js";
import { parseAttackAction, parseSaveAction } from "./grammar.js";
import {
  attackActivity,
  saveActivity,
  utilityActivity,
  toDamagePart,
  parseTemplate,
} from "./activities.js";

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
  feat: "icons/svg/book.svg",
  weapon: "icons/svg/sword.svg",
};

/**
 * Convert a parsed statblock to a Foundry dnd5e actor document.
 * If `resolvedImagePath` is provided, use it for both img and prototypeToken.texture.src.
 */
export function statblockToFoundryActor(statblock: StatblockData, resolvedImagePath?: string): Dnd5eActorDocument {
  const abilities_ = statblock.abilities_;

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
      movement: {
        walk: statblock.attributes.speed.walk ?? 0,
        fly: statblock.attributes.speed.fly ?? 0,
        swim: statblock.attributes.speed.swim ?? 0,
        burrow: statblock.attributes.speed.burrow ?? 0,
        climb: statblock.attributes.speed.climb ?? 0,
        units: "ft",
        hover: false,
      },
    },
    details: {
      biography: { value: "" },
      alignment: statblock.creatureType.alignment,
      race: { value: "" },
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
    skills: buildSkills(statblock),
  };

  // Create embedded items from abilities and actions
  const items: Dnd5eItem[] = [];

  // Add trait features (passive: the "trait" property, no activity)
  for (const ability of statblock.abilities) {
    const system = featSystem(ability.description);
    system.properties = ["trait"];
    items.push({
      name: ability.name,
      type: "feat",
      img: DEFAULT_ITEM_ICONS.feat,
      system,
    });
  }

  // Add actions (weapons and special actions)
  for (const action of statblock.actions) {
    items.push(actionToItem(action));
  }

  const actorImg = resolvedImagePath ?? statblock.data.image ?? undefined;
  return {
    name: statblock.data.name,
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
function buildSkills(statblock: StatblockData): Record<string, unknown> {
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

/** Item-level `uses` for a recharge action, else the empty default. */
function itemUses(recharge?: { value: number; charged: boolean }): Record<string, unknown> {
  if (!recharge) return { spent: 0, recovery: [], max: "" };
  return {
    spent: 0,
    max: "1",
    recovery: [{ period: "recharge", formula: String(recharge.value), type: "recoverAll" }],
  };
}

/** Shared scaffolding for `feat` items (traits, multiattack, save actions, reactions). */
function featSystem(description: string): Record<string, unknown> {
  return {
    description: { value: description, chat: "" },
    type: { value: "monster", subtype: "" },
    properties: [] as string[],
    requirements: "",
    uses: { spent: 0, recovery: [], max: "" },
    activities: {},
  };
}

/**
 * Convert an action to a Foundry item.
 *
 * Whether an action becomes a rollable "weapon" item or a plain "feat"
 * item is decided by whether the grammar parser actually found an attack
 * roll or saving throw in its description — not by which section it came
 * from. Purely descriptive actions/reactions (e.g. "Multiattack", "Sudden
 * Lurch") have no mechanical roll and belong in the official compendium as
 * "feat" items even though they're under the Actions/Reactions headers.
 */
function actionToItem(action: StatblockData["actions"][0]): Dnd5eItem {
  const attackParsed = parseAttackAction(action.description);
  const saveParsed = parseSaveAction(action.description);
  const activation = action.type === "reaction" ? ("reaction" as const) : ("action" as const);

  if (attackParsed) {
    const [base, ...extra] = attackParsed.damage;
    return {
      name: action.name,
      type: "weapon",
      img: DEFAULT_ITEM_ICONS.weapon,
      system: {
        description: { value: action.description, chat: "" },
        type: { value: "natural", baseItem: "" },
        damage: {
          // No parsed damage (rare): an inert base with no types.
          base: base
            ? toDamagePart(base)
            : { ...toDamagePart({ formula: "0d4", type: "" }), types: [] },
          versatile: {
            number: null,
            denomination: null,
            types: [],
            custom: { enabled: false },
            scaling: { number: 1 },
          },
        },
        range: {
          value: attackParsed.range?.normal ?? null,
          long: attackParsed.range?.long ?? null,
          reach: attackParsed.reach ?? null,
          units: "ft",
        },
        properties: [],
        proficient: null,
        uses: itemUses(action.recharge),
        activities: attackActivity({
          bonus: attackParsed.bonus,
          attackType: attackParsed.type === "ranged" ? "ranged" : "melee",
          extraParts: extra.map(toDamagePart),
          activation,
        }),
      },
    };
  }

  if (saveParsed) {
    const system = featSystem(action.description);
    system.uses = itemUses(action.recharge);
    system.activities = saveActivity({
      ability: saveParsed.ability.toLowerCase().substring(0, 3),
      dc: saveParsed.dc,
      parts: saveParsed.damage.map(toDamagePart),
      onSave: /success:\s*half/i.test(action.description) ? "half" : "none",
      template: parseTemplate(action.description),
      consumesItemUse: !!action.recharge,
      activation,
    });
    return { name: action.name, type: "feat", img: DEFAULT_ITEM_ICONS.feat, system };
  }

  // Purely descriptive (Multiattack, reactions without rolls, …): a feat with
  // a utility activity so it still shows under the right action economy.
  const system = featSystem(action.description);
  system.activities = utilityActivity({ activation });
  return { name: action.name, type: "feat", img: DEFAULT_ITEM_ICONS.feat, system };
}
