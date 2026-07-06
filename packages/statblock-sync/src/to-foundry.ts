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
import { SKILL_TO_ABBREVIATION_MAP, SKILL_DEFAULT_ABILITY } from "./utils.js";
import { parseAttackAction, parseSaveAction } from "./grammar.js";
import { getAbilityModifier, getProficiencyBonus, getAbilityMod } from "./math.js";
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

const KNOWN_DAMAGE_TYPES = new Set([
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
  "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
]);
const KNOWN_CONDITIONS = new Set([
  "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone",
  "restrained", "stunned", "unconscious",
]);
const KNOWN_LANGUAGES = new Set([
  "common", "dwarvish", "elvish", "giant", "gnomish", "goblin", "halfling",
  "orc", "abyssal", "celestial", "draconic", "deep speech", "infernal",
  "primordial", "sylvan", "undercommon", "common sign language", "thieves' cant", "druidic",
]);

/** Split a trait list into dnd5e keys vs. free text ("magical bludgeoning…"). */
function splitKnown(values: string[], known: Set<string>): { value: string[]; custom: string } {
  const value: string[] = [];
  const custom: string[] = [];
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (known.has(k)) value.push(k);
    else if (v.trim()) custom.push(v.trim());
  }
  return { value, custom: custom.join("; ") };
}

/** "darkvision 60 ft." lists → attributes.senses; passive Perception is derived, drop it. */
function buildSenses(senses: string[]): Record<string, unknown> {
  const ranges: Record<string, number | null> = {
    darkvision: null, blindsight: null, tremorsense: null, truesight: null,
  };
  const special: string[] = [];
  for (const s of senses) {
    const m = s.match(/(darkvision|blindsight|tremorsense|truesight)\s+(\d+)\s*ft/i);
    if (m) ranges[m[1]!.toLowerCase()] = parseInt(m[2]!, 10);
    else if (!/passive\s+perception/i.test(s)) special.push(s.trim());
  }
  return { units: null, special: special.join("; "), ranges };
}

/**
 * Convert a parsed statblock to a Foundry dnd5e actor document.
 * If `resolvedImagePath` is provided, use it for both img and prototypeToken.texture.src.
 */
export function statblockToFoundryActor(statblock: StatblockData, resolvedImagePath?: string): Dnd5eActorDocument {
  const abilities_ = statblock.abilities_;
  const prof = getProficiencyBonus(statblock.challenge.cr);

  // Skill proficiencies as multipliers; statblock-vs-derived deltas go in bonuses.check.
  const skills: Record<string, Record<string, unknown>> = {};
  for (const p of statblock.skills.proficiencies) {
    const abbrev = SKILL_TO_ABBREVIATION_MAP[p.skill.toLowerCase().replace(/ of hand/, "")];
    if (!abbrev) continue;
    const mod = getAbilityMod(abilities_, SKILL_DEFAULT_ABILITY[abbrev] ?? "wis");
    const delta = p.bonus - (mod + prof);
    skills[abbrev] = delta === 0 ? { value: 1 } : { value: 1, bonuses: { check: String(delta) } };
  }

  // Ability scores; save proficiencies live on abilities.<abl>.proficient.
  const abilities: Record<string, Record<string, unknown>> = {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"] as const) {
    abilities[key] = { value: abilities_[key] };
  }
  for (const save of statblock.skills.savingThrows) {
    const key = save.ability.toLowerCase().substring(0, 3);
    if (!abilities[key]) continue;
    const delta = save.bonus - (getAbilityModifier(abilities_[key as keyof typeof abilities_]) + prof);
    abilities[key]!.proficient = 1;
    if (delta !== 0) abilities[key]!.bonuses = { save: String(delta) };
  }

  const dr = splitKnown(statblock.traits.damageResistances, KNOWN_DAMAGE_TYPES);
  const di = splitKnown(statblock.traits.damageImmunities, KNOWN_DAMAGE_TYPES);
  const dv = splitKnown(statblock.traits.damageVulnerabilities, KNOWN_DAMAGE_TYPES);
  const ci = splitKnown(statblock.traits.conditionImmunities, KNOWN_CONDITIONS);
  const langs = splitKnown(statblock.traits.languages, KNOWN_LANGUAGES);

  // Build system object
  const system: Record<string, unknown> = {
    attributes: {
      ac: {
        flat: statblock.attributes.armorClass,
        calc: /natural/i.test(statblock.data.ac_class ?? "") ? "natural" : "flat",
      },
      hp: {
        value: statblock.attributes.hitPoints.value,
        max: statblock.attributes.hitPoints.value,
        formula: statblock.attributes.hitPoints.formula,
      },
      movement: {
        // Only the speeds the statblock has — officials omit absent speeds
        // entirely (ghast: walk only; wyrmling: walk/fly/swim/burrow).
        ...Object.fromEntries(
          Object.entries(statblock.attributes.speed).filter(
            ([, v]) => typeof v === "number" && v > 0,
          ),
        ),
        units: "ft",
        hover: false,
      },
      senses: buildSenses(statblock.traits.senses),
    },
    details: {
      biography: { value: "" },
      alignment: statblock.creatureType.alignment,
      type: {
        value: statblock.creatureType.type,
        subtype: statblock.creatureType.subtype ?? "",
      },
      cr: statblock.challenge.cr,
      // No xp (dnd5e derives it from CR) and — critically — no `race`: on
      // NPCs it's a LocalDocumentField (Item reference, officially null); the
      // legacy `race: { value: "" }` is what dry-run rejected with
      // "The value provided to a LocalDocumentField must be a BaseItem instance."
    },
    traits: {
      size: statblock.creatureType.size,
      languages: { value: langs.value, custom: langs.custom, communication: {} },
      dr: { value: dr.value, bypasses: [], custom: dr.custom },
      di: { value: di.value, bypasses: [], custom: di.custom },
      dv: { value: dv.value, bypasses: [], custom: dv.custom },
      ci: { value: ci.value, custom: ci.custom },
    },
    abilities,
    skills,
  };

  // Create embedded items from abilities and actions
  const items: Dnd5eItem[] = [];

  // Add trait features (passive: the "trait" property, no activity)
  for (const ability of statblock.abilities) {
    const itemSystem = featSystem(ability.description);
    itemSystem.properties = ["trait"];
    items.push({
      name: ability.name,
      type: "feat",
      img: DEFAULT_ITEM_ICONS.feat,
      system: itemSystem,
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
