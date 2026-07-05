/**
 * Parse Obsidian Fantasy Statblocks from markdown into structured data.
 *
 * Statblocks are markdown files with a YAML front-matter (metadata) followed by
 * the body. This module extracts and parses both, yielding a StatblockData object.
 */

import { parse as parseYaml } from "yaml";
import type { StatblockFrontMatter, StatblockData } from "./schema.js";
import { StatblockFrontMatterSchema } from "./schema.js";
import {
  extractRegexInt,
  extractRegexGroup,
  parseTraitList,
  SIZE_TO_ABBREVIATION_MAP,
} from "./utils.js";

/**
 * Regex to match YAML front-matter block at the start of a markdown file.
 * Matches: ---\n...content...\n---\n
 */
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parse a statblock markdown string into front-matter and body components.
 */
export function parseStatblockRaw(raw: string): {
  frontMatter: Record<string, unknown>;
  body: string;
} {
  // Normalize CRLF → LF for consistent parsing
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = FRONT_MATTER_RE.exec(normalized);

  if (!match || !match[1]) {
    return {
      frontMatter: {},
      body: normalized,
    };
  }

  const fmRaw = match[1];
  const bodyRaw = match[2] ?? "";

  const frontMatter = (parseYaml(fmRaw) as Record<string, unknown>) ?? {};

  return {
    frontMatter,
    body: bodyRaw,
  };
}

/**
 * Parse a complete statblock markdown file.
 *
 * Returns a StatblockData object with:
 * - frontMatter: validated metadata
 * - body: raw markdown body
 * - attributes: AC, HP, speed (parsed from lines like "**Armor Class** 15")
 * - abilities: AC, STR, etc. parsed from the ability score table
 * - skills, traits, challenge: parsed from sections
 * - abilities: trait/ability features (extracted from headers like "## Abilities")
 * - actions: actions and reactions (extracted from headers like "## Actions")
 */
export function parseStatblock(raw: string): StatblockData {
  const { frontMatter, body } = parseStatblockRaw(raw);

  // Validate front-matter
  const fm = StatblockFrontMatterSchema.parse(frontMatter);

  const attributes = parseAttributes(body);
  const abilities = parseAbilityScores(body);
  const skills = parseSkillsAndSaves(body);
  const traits = parseTraits(body);
  const challenge = parseChallenge(body, fm.cr);
  const creatureType = parseCreatureType(body);
  const abilityFeatures = parseAbilities(body);
  const actions = parseActions(body);

  return {
    frontMatter: fm,
    body,
    attributes,
    abilities_: abilities,
    skills,
    traits,
    challenge,
    creatureType,
    abilities: abilityFeatures,
    actions,
  };
}

/**
 * Parse the size/type/alignment descriptor line that follows the name heading.
 * Example: "*Medium undead, chaotic evil*" or "*Large humanoid (goblinoid), chaotic evil*"
 */
function parseCreatureType(body: string): StatblockData["creatureType"] {
  const match = body.match(
    /\*([A-Za-z]+)\s+([A-Za-z]+)(?:\s*\(([^)]+)\))?,\s*([^*\n]+)\*/
  );

  if (!match || !match[1] || !match[2] || !match[4]) {
    return { size: "med", type: "humanoid", alignment: "" };
  }

  const size = SIZE_TO_ABBREVIATION_MAP[match[1].toLowerCase()] ?? "med";

  return {
    size,
    type: match[2].toLowerCase(),
    subtype: match[3]?.trim(),
    alignment: match[4].trim(),
  };
}

/**
 * Parse attributes from lines like:
 * **Armor Class** 15 (natural armor)
 * **Hit Points** 52 (8d8 + 16)
 * **Speed** 30 ft.
 */
function parseAttributes(body: string): StatblockData["attributes"] {
  const acValue = extractRegexInt(body, /\*\*Armor Class\*\*\s+(\d+)/, 1, 10);
  const hpValue = extractRegexInt(body, /\*\*Hit Points\*\*\s+(\d+)/, 1, 1);
  const hpFormula = extractRegexGroup(body, /\*\*Hit Points\*\*\s+\d+\s*\(([^)]+)\)/, 1, "1d8") || "1d8";
  const speedMatch = body.match(/\*\*Speed\*\*\s+([^\n]+)/);

  const speed: StatblockData["attributes"]["speed"] = { walk: 30 };
  if (speedMatch && speedMatch[1]) {
    const speedText = speedMatch[1];
    const walkMatch = speedText.match(/(\d+)\s+ft\.(?!\w)/);
    if (walkMatch && walkMatch[1]) speed.walk = parseInt(walkMatch[1], 10);

    const flyMatch = speedText.match(/fly\s+(\d+)\s+ft/i);
    if (flyMatch && flyMatch[1]) speed.fly = parseInt(flyMatch[1], 10);

    const swimMatch = speedText.match(/swim\s+(\d+)\s+ft/i);
    if (swimMatch && swimMatch[1]) speed.swim = parseInt(swimMatch[1], 10);
  }

  return {
    armorClass: acValue,
    hitPoints: { value: hpValue, formula: hpFormula },
    speed,
  };
}

/**
 * Parse ability scores from the standard ability score table.
 * Example:
 * | STR | DEX | CON | INT | WIS | CHA |
 * |:---:|:---:|:---:|:---:|:---:|:---:|
 * | 16 (+3) | 14 (+2) | 14 (+2) | 9 (-1) | 11 (+0) | 8 (-1) |
 */
function parseAbilityScores(body: string): StatblockData["abilities_"] {
  const abilityLineMatch = body.match(
    /\|\s*(\d+)\s*\([^)]+\)\s*\|\s*(\d+)\s*\([^)]+\)\s*\|\s*(\d+)\s*\([^)]+\)\s*\|\s*(\d+)\s*\([^)]+\)\s*\|\s*(\d+)\s*\([^)]+\)\s*\|\s*(\d+)\s*\([^)]+\)\s*\|/
  );

  if (!abilityLineMatch || !abilityLineMatch[1] || !abilityLineMatch[2] || !abilityLineMatch[3] || !abilityLineMatch[4] || !abilityLineMatch[5] || !abilityLineMatch[6]) {
    return { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  }

  return {
    str: parseInt(abilityLineMatch[1], 10),
    dex: parseInt(abilityLineMatch[2], 10),
    con: parseInt(abilityLineMatch[3], 10),
    int: parseInt(abilityLineMatch[4], 10),
    wis: parseInt(abilityLineMatch[5], 10),
    cha: parseInt(abilityLineMatch[6], 10),
  };
}

/**
 * Parse skills and saving throws from lines like:
 * **Skills** Perception +2, Stealth +4
 * **Saving Throws** Wis +2, Cha +1
 */
function parseSkillsAndSaves(body: string): StatblockData["skills"] {
  const proficiencies = [] as StatblockData["skills"]["proficiencies"];
  const savingThrows = [] as StatblockData["skills"]["savingThrows"];

  const skillsMatch = body.match(/\*\*Skills\*\*\s+([^\n]+)/i);
  if (skillsMatch && skillsMatch[1]) {
    const skillText = skillsMatch[1].trim();
    const skillPairs = skillText.split(",").map((s) => s.trim());
    for (const pair of skillPairs) {
      const match = pair.match(/([A-Za-z\s]+?)\s*([+-]\d+)/);
      if (match && match[1] && match[2]) {
        const skillName = match[1].trim();
        const bonus = parseInt(match[2], 10);
        proficiencies.push({
          skill: skillName,
          bonus,
          proficient: true,
        });
      }
    }
  }

  const savesMatch = body.match(/\*\*Saving Throws\*\*\s+([^\n]+)/i);
  if (savesMatch && savesMatch[1]) {
    const savesText = savesMatch[1].trim();
    const savePairs = savesText.split(",").map((s) => s.trim());
    for (const pair of savePairs) {
      const match = pair.match(/(\w+)\s*([+-]\d+)/);
      if (match && match[1] && match[2]) {
        const ability = match[1];
        const bonus = parseInt(match[2], 10);
        savingThrows.push({
          ability,
          bonus,
          proficient: true,
        });
      }
    }
  }

  return { proficiencies, savingThrows };
}

/**
 * Parse traits (damage resistances, immunities, senses, etc.) from lines like:
 * **Damage Resistances** necrotic
 * **Senses** darkvision 60 ft., passive Perception 12
 */
function parseTraits(body: string): StatblockData["traits"] {
  return {
    damageResistances: parseTraitList(body, "Damage Resistances"),
    damageImmunities: parseTraitList(body, "Damage Immunities"),
    damageVulnerabilities: parseTraitList(body, "Damage Vulnerabilities"),
    conditionImmunities: parseTraitList(body, "Condition Immunities"),
    senses: parseTraitList(body, "Senses"),
    languages: parseTraitList(body, "Languages"),
  };
}

/**
 * Parse challenge rating and compute XP.
 */
function parseChallenge(body: string, crFromFm?: number): StatblockData["challenge"] {
  const crMatch = body.match(/\*\*Challenge\*\*\s+([\d./]+)/i);
  let crValue: number = 0;

  if (typeof crFromFm === "number") {
    crValue = crFromFm;
  } else if (crMatch && crMatch[1]) {
    const crStr = crMatch[1];
    if (crStr.includes("/")) {
      const parts = crStr.split("/").map((s) => parseInt(s, 10));
      if (parts[0] !== undefined && parts[1] !== undefined) {
        crValue = parts[0] / parts[1];
      } else {
        crValue = parseFloat(crStr);
      }
    } else {
      crValue = parseFloat(crStr);
    }
  }

  // Compute XP from CR using the standard D&D 5e Monster Manual table
  const xpByCr: Record<number, number> = {
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
  const xp: number = xpByCr[crValue] ?? 0;

  const result: StatblockData["challenge"] = { cr: crValue, xp };
  return result;
}

/**
 * Parse ability features (e.g., "## Abilities" section) that describe passive traits.
 */
function parseAbilities(body: string): StatblockData["abilities"] {
  const abilities: StatblockData["abilities"] = [];

  // Match headers like "## Abilities" or "## Features"
  const abilitySection = body.match(/##\s*(?:Abilities|Features)([\s\S]*?)(?=##|$)/i);
  if (abilitySection && abilitySection[1]) {
    const content = abilitySection[1];
    // Match bold headers followed by description
    const features = content.matchAll(/\*\*([^*]+)\*\*\.?\s*([^\n]*(?:\n(?!\*\*)[^\n]*)*)/g);
    for (const match of features) {
      let name = match[1] || "";
      name = name.replace(/\.$/, "");
      const description = match[2] || "";
      abilities.push({
        name,
        description: description.trim(),
        passive: true,
      });
    }
  }

  return abilities;
}

/**
 * Parse actions and reactions from body, detecting multiattack, recharge, etc.
 */
function parseActions(body: string): StatblockData["actions"] {
  const actions: StatblockData["actions"] = [];

  // Match "## Actions" and "## Reactions" sections
  const actionsSection = body.match(/##\s*Actions([\s\S]*?)(?=##|$)/i);
  const reactionsSection = body.match(/##\s*Reactions([\s\S]*?)(?=##|$)/i);

  if (actionsSection) {
    parseActionBlock(actionsSection[1] || undefined, "action", actions);
  }
  if (reactionsSection) {
    parseActionBlock(reactionsSection[1] || undefined, "reaction", actions);
  }

  return actions;
}

/**
 * Helper to parse a single action block.
 */
function parseActionBlock(
  content: string | undefined,
  type: "action" | "reaction" | "legendary" | "lair",
  actions: StatblockData["actions"]
) {
  if (!content) return;

  // Match bold action headers
  const actionMatches = content.matchAll(/\*\*([^*]+)\*\*\.?\s*([^\n]*(?:\n(?!\*\*)[^\n]*)*)/g);

  for (const match of actionMatches) {
    let name = match[1] || "";
    // Strip trailing period from name if present
    name = name.replace(/\.$/, "");
    const description = match[2] || "";

    const action: StatblockData["actions"][0] = {
      name,
      type,
      description: description.trim(),
      multiattack: name.toLowerCase().includes("multiattack"),
    };

    // Check for recharge
    const rechargeMatch = description.match(/[Rr]echarge\s+(\d)/);
    if (rechargeMatch && rechargeMatch[1]) {
      action.recharge = {
        value: parseInt(rechargeMatch[1], 10),
        charged: true,
      };
    }

    actions.push(action);
  }
}
