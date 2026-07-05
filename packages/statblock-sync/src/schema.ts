/**
 * Schema and field mapping for Obsidian Fantasy Statblocks.
 *
 * Statblocks contain two types of fields:
 * - Authored: the statblock creator's original content (abilities, actions, reactions)
 * - Managed: live-world state that is pulled back from Foundry (HP, effects, token state)
 */

import { z } from "zod";

/**
 * The parsed statblock with metadata, abilities, and actions parsed from markdown.
 */
export interface StatblockData {
  /** Front-matter metadata from the markdown file */
  frontMatter: {
    name: string;
    type: string;
    cr?: number;
    source?: string;
    image?: string; // path to the image file (e.g., "gravemire-stalker.png")
    [key: string]: unknown;
  };

  /** The raw markdown body (everything after ---) */
  body: string;

  /** Parsed abilities extracted from the body */
  abilities: {
    name: string;
    description: string;
    passive?: boolean;
  }[];

  /** Parsed actions and reactions */
  actions: {
    name: string;
    type: "action" | "reaction" | "legendary" | "lair";
    description: string;
    multiattack?: boolean;
    recharge?: {
      value: number; // 5 or 6
      charged: boolean;
    };
  }[];

  /** Parsed attributes from the statblock (AC, HP, speeds, etc.) */
  attributes: {
    armorClass: number;
    hitPoints: {
      value: number;
      formula: string;
    };
    speed: {
      walk?: number;
      fly?: number;
      swim?: number;
      burrow?: number;
      climb?: number;
      [key: string]: number | undefined;
    };
  };

  /** Parsed ability scores */
  abilities_: {
    str: number;
    dex: number;
    con: number;
    int: number;
    wis: number;
    cha: number;
  };

  /** Parsed skills and proficiencies */
  skills: {
    proficiencies: Array<{
      skill: string;
      bonus: number;
      proficient: boolean;
    }>;
    savingThrows: Array<{
      ability: string;
      bonus: number;
      proficient: boolean;
    }>;
  };

  /** Resistances, immunities, and vulnerabilities */
  traits: {
    damageResistances: string[];
    damageImmunities: string[];
    damageVulnerabilities: string[];
    conditionImmunities: string[];
    senses: string[];
    languages: string[];
  };

  /** Challenge rating and XP */
  challenge: {
    cr: number;
    xp: number;
  };
}

/**
 * Statblock field mapping: maps Markdown field names to dnd5e actor system paths.
 * Each entry maps a statblock concept to its Foundry equivalent.
 */
export const STATBLOCK_FIELD_MAP = {
  // Basic attributes
  name: "name",
  type: "type",
  size: "system.details.size",
  alignment: "system.details.alignment",
  race: "system.details.race.value",

  // Armor and hit points
  armorClass: "system.attributes.ac.flat",
  hitPoints: "system.attributes.hp.value",
  hitPointsMax: "system.attributes.hp.max",
  hitPointsFormula: "system.attributes.hp.formula",

  // Ability scores
  strength: "system.abilities.str.value",
  dexterity: "system.abilities.dex.value",
  constitution: "system.abilities.con.value",
  intelligence: "system.abilities.int.value",
  wisdom: "system.abilities.wis.value",
  charisma: "system.abilities.cha.value",

  // Skills and saving throws (proficiencies)
  skillProficiencies: "system.skills",
  savingThrowProficiencies: "system.abilities.*.save",

  // Traits and senses
  damageResistances: "system.traits_.damageResistances.value",
  damageImmunities: "system.traits_.damageImmunities.value",
  conditionImmunities: "system.traits_.conditionImmunities.value",
  senses: "system.traits.senses",

  // CR and XP
  challengeRating: "system.details.cr",
  experiencePoints: "system.details.xp",

  // Portrait and token images
  portraitImage: "img",
  tokenImage: "img", // shared with portrait in basic import; tokenizer can split later
};

/**
 * Schema for the front-matter section of a statblock markdown file.
 */
export const StatblockFrontMatterSchema = z.object({
  name: z.string().min(1, "name is required"),
  type: z.enum(["npc", "creature", "monster"], {
    errorMap: () => ({ message: "type must be one of: npc, creature, monster" }),
  }),
  cr: z.number().min(0).optional(),
  source: z.string().optional(),
  image: z.string().optional(),
  /** Allow additional untyped properties for future extensibility */
}).passthrough();

export type StatblockFrontMatter = z.infer<typeof StatblockFrontMatterSchema>;

/**
 * Schema for parsed ability/skill lines (e.g., "Acrobatics +2, Perception +4").
 */
export const SkillLineSchema = z.object({
  skill: z.string(),
  bonus: z.number(),
  proficient: z.boolean().optional(),
});

export type SkillLine = z.infer<typeof SkillLineSchema>;

/**
 * Schema for a single ability score mod derivation (used in tests).
 */
export const AbilityModSchema = z.object({
  score: z.number().int().min(1).max(30),
  modifier: z.number().int(),
});

export type AbilityMod = z.infer<typeof AbilityModSchema>;
