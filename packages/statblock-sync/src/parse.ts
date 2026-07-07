/**
 * Parse Obsidian Fantasy Statblocks notes into structured data.
 *
 * A Fantasy Statblocks note is an ordinary Obsidian note with a single
 * ```statblock fenced code block somewhere in its body; the fence contains
 * one YAML document with the creature's mechanical fields (ac, hp, stats,
 * actions, ...). Prose above and below the fence is the author's own notes
 * and is preserved untouched — this module only reads/replaces the fence.
 */

import { parse as parseYaml } from "yaml";
import type { Statblock, StatblockData } from "./schema.js";
import { StatblockSchema } from "./schema.js";
import { SIZE_TO_ABBREVIATION_MAP } from "./utils.js";

/**
 * Regex to match a ```statblock fenced code block anywhere in a note,
 * capturing the prose before it, the YAML content inside it, and the prose
 * after it.
 */
const STATBLOCK_FENCE_RE = /^([\s\S]*?)```statblock\n([\s\S]*?)\n```\s*\n?([\s\S]*)$/;

/** Standard D&D 5e Monster Manual CR-to-XP table. */
const XP_BY_CR: Record<number, number> = {
  0: 10,
  "0.125": 25,
  "0.25": 50,
  "0.5": 100,
  1: 200,
  2: 450,
  3: 700,
  4: 1100,
  5: 1800,
  6: 2300,
  7: 2900,
  8: 3900,
  9: 5000,
  10: 5900,
  11: 7200,
  12: 8400,
  13: 10000,
  14: 11500,
  15: 13000,
  16: 15000,
  17: 18000,
  18: 20000,
  19: 22000,
  20: 25000,
  21: 33000,
  22: 41000,
  23: 50000,
  24: 62000,
  25: 75000,
  26: 90000,
  27: 105000,
  28: 120000,
  29: 135000,
  30: 155000,
};

/**
 * Extract the ```statblock fence's YAML content from a note, along with the
 * surrounding prose (for round-tripping). If no fence is found, the whole
 * note is treated as prose and `data` is empty.
 */
export function parseStatblockRaw(raw: string): {
  data: Record<string, unknown>;
  prose: { before: string; after: string };
} {
  // Normalize CRLF → LF for consistent parsing
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = STATBLOCK_FENCE_RE.exec(normalized);

  if (!match || match[2] === undefined) {
    return {
      data: {},
      prose: { before: normalized, after: "" },
    };
  }

  const before = match[1] ?? "";
  const yamlContent = match[2];
  const after = match[3] ?? "";

  const data = (parseYaml(yamlContent) as Record<string, unknown>) ?? {};

  return {
    data,
    prose: { before, after },
  };
}

/**
 * Parse a complete Fantasy Statblocks note.
 *
 * Returns a StatblockData object with the validated fenced fields (`data`),
 * the surrounding prose, and mechanics derived from both: attributes (AC,
 * HP, speed), ability scores, skills/saves, traits, challenge/XP, creature
 * type, and abilities/actions.
 */
export function parseStatblock(raw: string): StatblockData {
  const { data, prose } = parseStatblockRaw(raw);

  const sb = StatblockSchema.parse(data);

  return {
    data: sb,
    prose,
    attributes: buildAttributes(sb),
    abilities_: buildAbilityScores(sb),
    skills: buildSkillsAndSaves(sb),
    traits: buildTraits(sb),
    challenge: buildChallenge(sb),
    creatureType: buildCreatureType(sb),
    abilities: buildAbilities(sb),
    actions: buildActions(sb),
  };
}

/**
 * Derive AC/HP/speed from the flat `ac`, `hp`, `hit_dice`, and `speed` fields.
 */
function buildAttributes(sb: Statblock): StatblockData["attributes"] {
  const speed: StatblockData["attributes"]["speed"] = {};

  if (sb.speed) {
    const walkMatch = sb.speed.match(/(\d+)\s*ft\.?/i);
    if (walkMatch?.[1]) speed.walk = parseInt(walkMatch[1], 10);

    const flyMatch = sb.speed.match(/fly\s+(\d+)\s*ft/i);
    if (flyMatch?.[1]) speed.fly = parseInt(flyMatch[1], 10);

    const swimMatch = sb.speed.match(/swim\s+(\d+)\s*ft/i);
    if (swimMatch?.[1]) speed.swim = parseInt(swimMatch[1], 10);

    const burrowMatch = sb.speed.match(/burrow\s+(\d+)\s*ft/i);
    if (burrowMatch?.[1]) speed.burrow = parseInt(burrowMatch[1], 10);

    const climbMatch = sb.speed.match(/climb\s+(\d+)\s*ft/i);
    if (climbMatch?.[1]) speed.climb = parseInt(climbMatch[1], 10);
  }

  return {
    armorClass: sb.ac,
    hitPoints: { value: sb.hp, formula: sb.hit_dice ?? "" },
    speed,
  };
}

/** Ability scores come directly from the `stats: [str, dex, con, int, wis, cha]` tuple. */
function buildAbilityScores(sb: Statblock): StatblockData["abilities_"] {
  const [str, dex, con, int, wis, cha] = sb.stats;
  return { str, dex, con, int, wis, cha };
}

/**
 * `saves`/`skillsaves` are lists of single-key maps, e.g.
 * `saves: [{ wisdom: 3 }]` and `skillsaves: [{ stealth: 4 }, { perception: 3 }]`.
 * Both already store the creature's total bonus, so no ability-mod math is
 * needed here.
 */
function buildSkillsAndSaves(sb: Statblock): StatblockData["skills"] {
  const proficiencies = (sb.skillsaves ?? []).flatMap((entry) =>
    Object.entries(entry).map(([skill, bonus]) => ({ skill, bonus, proficient: true }))
  );

  const savingThrows = (sb.saves ?? []).flatMap((entry) =>
    Object.entries(entry).map(([ability, bonus]) => ({ ability, bonus, proficient: true }))
  );

  return { proficiencies, savingThrows };
}

/**
 * Split a comma-separated trait string (e.g. "necrotic, cold") into a list.
 * Strips a leading "and " so an Oxford-comma list's last item ("cold, fire,
 * and lightning") survives as "lightning", not "and lightning" — the latter
 * fails every known-type lookup and silently drops into free-text custom.
 */
function splitTraitList(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((s) => s.trim().replace(/^and\s+/i, ""))
        .filter(Boolean)
    : [];
}

/**
 * Qualifier phrases that scope a damage-type clause to a condition (e.g.
 * "nonmagical attacks", "that aren't silvered") rather than granting the
 * listed types unconditionally.
 */
const DAMAGE_QUALIFIER_RE = /\bnonmagical\b|\bnon-magical\b|\bsilvered\b|\badamantine\b/i;

/**
 * Split a damage-type list (resistances/immunities/vulnerabilities), but keep
 * a clause intact — as one opaque entry — when it carries a qualifier like
 * "from nonmagical attacks". Naively comma-splitting "bludgeoning, piercing,
 * and slashing from nonmagical attacks" would grant unconditional resistance
 * to bludgeoning and piercing (wrong: the qualifier applies to the whole
 * clause). The caller (to-foundry.ts) can't reconstruct a lost qualifier, so
 * it must never see the clause pre-shredded.
 *
 * Clauses are separated by ";" (e.g. "cold; bludgeoning, piercing, and
 * slashing from nonmagical attacks") — commas only enumerate types *within*
 * a clause, so the qualifier check and comma-split both apply per clause,
 * not to the whole string (otherwise one qualified clause would swallow an
 * unrelated, unconditional resistance listed alongside it).
 */
function splitDamageTraitList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((clause) => clause.trim())
    .filter(Boolean)
    .flatMap((clause) => (DAMAGE_QUALIFIER_RE.test(clause) ? [clause] : splitTraitList(clause)));
}

function buildTraits(sb: Statblock): StatblockData["traits"] {
  return {
    damageResistances: splitDamageTraitList(sb.damage_resistances),
    damageImmunities: splitDamageTraitList(sb.damage_immunities),
    damageVulnerabilities: splitDamageTraitList(sb.damage_vulnerabilities),
    conditionImmunities: splitTraitList(sb.condition_immunities),
    senses: splitTraitList(sb.senses),
    languages: splitTraitList(sb.languages),
  };
}

/** Parse challenge rating (number, or a "1/4"-style fraction string) and compute XP. */
function buildChallenge(sb: Statblock): StatblockData["challenge"] {
  let crValue: number;

  if (typeof sb.cr === "number") {
    crValue = sb.cr;
  } else if (sb.cr.includes("/")) {
    const [num, denom] = sb.cr.split("/").map((s) => parseInt(s, 10));
    crValue = num !== undefined && denom !== undefined ? num / denom : parseFloat(sb.cr);
  } else {
    crValue = parseFloat(sb.cr);
  }

  const xp = XP_BY_CR[crValue] ?? 0;

  return { cr: crValue, xp };
}

/** Derive size/type/subtype/alignment from the `size`, `type`, and `alignment` fields. */
function buildCreatureType(sb: Statblock): StatblockData["creatureType"] {
  const size = SIZE_TO_ABBREVIATION_MAP[(sb.size ?? "Medium").toLowerCase()] ?? "med";

  // `type` may carry a subtype in parens, e.g. "humanoid (goblinoid)"
  const typeMatch = (sb.type ?? "humanoid").match(/^([a-zA-Z]+)(?:\s*\(([^)]+)\))?/);

  return {
    size,
    type: (typeMatch?.[1] ?? "humanoid").toLowerCase(),
    subtype: typeMatch?.[2]?.trim(),
    alignment: sb.alignment ?? "",
  };
}

/** The `traits` list becomes passive ability/feature entries. */
function buildAbilities(sb: Statblock): StatblockData["abilities"] {
  return (sb.traits ?? []).map((t) => ({
    name: t.name,
    description: t.desc,
    passive: true,
  }));
}

/** Extract a "(Recharge X-Y)" suffix from an action name, returning the clean name and recharge info. */
function extractRecharge(name: string): {
  name: string;
  recharge?: { value: number; charged: boolean };
} {
  const rechargeMatch = name.match(/\s*\(Recharge\s+(\d)(?:-\d)?\)/i);
  if (!rechargeMatch?.[1]) return { name };

  return {
    name: name.replace(rechargeMatch[0], "").trim(),
    recharge: { value: parseInt(rechargeMatch[1], 10), charged: true },
  };
}

/** The `actions`/`reactions`/`legendary_actions` lists become the actions array. */
function buildActions(sb: Statblock): StatblockData["actions"] {
  const fromList = (
    list: Array<{ name: string; desc: string }> | undefined,
    type: "action" | "reaction" | "legendary"
  ): StatblockData["actions"] =>
    (list ?? []).map((entry) => {
      const { name, recharge } = extractRecharge(entry.name);
      return {
        name,
        type,
        description: entry.desc,
        multiattack: name.toLowerCase().includes("multiattack"),
        recharge,
      };
    });

  return [
    ...fromList(sb.actions, "action"),
    ...fromList(sb.reactions, "reaction"),
    ...fromList(sb.legendary_actions, "legendary"),
  ];
}
