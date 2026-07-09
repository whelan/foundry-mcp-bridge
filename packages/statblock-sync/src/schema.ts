/**
 * Schema and field mapping for Obsidian Fantasy Statblocks.
 *
 * Statblocks contain two types of fields:
 * - Authored: the statblock creator's original content (abilities, actions, reactions)
 * - Managed: live-world state that is pulled back from Foundry (HP, effects, token state)
 */

import { z } from "zod";

/**
 * Zod schema for a single named entry with a description, used for traits,
 * actions, reactions, and legendary actions.
 */
const NamedEntrySchema = z.object({
  name: z.string(),
  desc: z.string(),
});

/**
 * Schema for the YAML data inside a Fantasy Statblocks ```statblock fence.
 * This is the plugin's native "basic 5e" layout: a single YAML document with
 * flat mechanical fields (ac, hp, stats, ...) plus lists of name/desc entries
 * for traits, actions, reactions, and legendary actions.
 */
export const StatblockSchema = z
  .object({
    name: z.string().min(1, "name is required"),
    image: z.string().optional(),
    size: z.string().optional(), // "Tiny" | "Small" | "Medium" | "Large" | "Huge" | "Gargantuan"
    type: z.string().optional(), // "undead", "humanoid (goblinoid)", etc.
    alignment: z.string().optional(),
    ac: z.number(),
    ac_class: z.string().optional(), // flavor text, e.g. "natural armor"
    hp: z.number(),
    hit_dice: z.string().optional(),
    speed: z.string().optional(), // "30 ft., swim 20 ft."
    stats: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
    saves: z.array(z.record(z.string(), z.number())).optional(),
    skillsaves: z.array(z.record(z.string(), z.number())).optional(),
    damage_resistances: z.string().optional(),
    damage_immunities: z.string().optional(),
    damage_vulnerabilities: z.string().optional(),
    condition_immunities: z.string().optional(),
    senses: z.string().optional(),
    languages: z.string().optional(),
    cr: z.union([z.number(), z.string()]),
    traits: z.array(NamedEntrySchema).optional(),
    actions: z.array(NamedEntrySchema).optional(),
    reactions: z.array(NamedEntrySchema).optional(),
    legendary_actions: z.array(NamedEntrySchema).optional(),
    lair_actions: z.array(NamedEntrySchema).optional(),
    /** Explicit legendary-action budget override; defaults to legendary_actions.length when absent. */
    legendary_action_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type Statblock = z.infer<typeof StatblockSchema>;

/**
 * The parsed statblock: the validated fenced-block fields, the prose
 * surrounding the fence (for round-tripping), and mechanics derived from
 * both.
 */
export interface StatblockData {
  /** Validated fields parsed from the ```statblock fence */
  data: Statblock;

  /** Prose surrounding the fence in the source note, preserved byte-for-byte */
  prose: {
    before: string;
    after: string;
  };

  /** Parsed abilities/traits (from the `traits` list) */
  abilities: {
    name: string;
    description: string;
    passive?: boolean;
    /** Parsed "(N/Day)" count from a "Legendary Resistance" trait name, if present. */
    legendaryResistanceUses?: number;
  }[];

  /** Parsed actions, reactions, and legendary actions */
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

  /** Derived attributes (AC, HP, speeds, etc.) */
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

  /** Derived from `size`/`type`/`alignment`, e.g. size "Medium", type "undead" */
  creatureType: {
    size: string; // dnd5e size code: tiny, sm, med, lg, huge, grg
    type: string; // "undead", "humanoid", etc.
    subtype?: string; // e.g. "goblinoid" from "humanoid (goblinoid)"
    alignment: string;
  };

  /** Ability scores, from `stats: [str, dex, con, int, wis, cha]` */
  abilities_: {
    str: number;
    dex: number;
    con: number;
    int: number;
    wis: number;
    cha: number;
  };

  /** Skill and saving throw proficiencies, from `skillsaves`/`saves` */
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

  /** Parsed from a "Spellcasting" trait's raw text, if present (innate spellcasting is out of scope). */
  spellcasting?: {
    /** Three-letter ability key, e.g. "int". */
    ability: string;
    dc: number;
    attackBonus: number;
    levels: Array<{
      /** 0 = cantrips. */
      level: number;
      /** Absent for cantrips (at will). */
      slots?: number;
      spellNames: string[];
    }>;
  };
}

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
