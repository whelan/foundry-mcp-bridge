/**
 * M3: Action text grammar parser
 *
 * Parses attack, save, and other mechanics from 2024 D&D statblock descriptions.
 *
 * Example inputs:
 * - "Melee Attack Roll: +5 to hit, reach 5 ft., one target. Hit: 10 (2d6 + 3) slashing damage plus 3 (1d6) necrotic damage."
 * - "Wisdom Saving Throw: DC 13. Each creature that can hear it and fails the save takes 22 (4d10) psychic damage, or half as much on a successful one."
 */

import type { StatblockData } from "./schema.js";
import { DAMAGE_TYPES_STR, stripMarkdown } from "./utils.js";

/** Regex pattern for main damage: "N (XdY ± Z) type damage" */
const DAMAGE_PATTERN = new RegExp(
  `(\\d+)\\s*\\(([^)]+)\\)\\s*(${DAMAGE_TYPES_STR})`,
  "gi"
);

/** Regex pattern for plus damage: "plus N (XdY ± Z) type damage" */
const PLUS_PATTERN = new RegExp(
  `plus\\s+(\\d+)\\s*\\(([^)]+)\\)\\s*(${DAMAGE_TYPES_STR})`,
  "gi"
);

/**
 * Parsed attack action details.
 */
export interface ParsedAttack {
  name: string;
  type: "melee" | "ranged" | "melee_ranged";
  bonus: number;
  reach?: number;
  range?: { normal: number; long?: number };
  targets: string; // "one target", "up to three targets", etc.
  damage: DamagePart[];
}

/**
 * A single damage component (e.g., "2d6 + 3 slashing" or "1d6 necrotic").
 */
export interface DamagePart {
  formula: string; // "2d6 + 3", "4d10", etc.
  type: string; // "slashing", "psychic", etc.
  isAlternative?: boolean; // true if "or X on success" pattern
}

/**
 * Parsed save action details.
 */
export interface ParsedSave {
  name: string;
  dc: number;
  ability: string; // "Wisdom", "Dexterity", etc.
  damage: DamagePart[];
  successEffect?: string; // e.g., "half as much on a successful one"
}

/**
 * Try to parse an action as a melee weapon attack (2024 format).
 * Looks for patterns like "Melee Attack Roll: +5" or "Ranged Attack Roll: +5"
 */
export function parseAttackAction(description: string): ParsedAttack | undefined {
  // Strip markdown formatting (asterisks for italics/bold)
  const normalized = stripMarkdown(description);

  // 2024 format: "Melee Attack Roll: +5" or "Ranged Attack Roll: +5"
  const attackMatch = normalized.match(
    /(?:melee|ranged)\s+attack\s+roll:\s*([+-]\d+)/i
  );

  if (!attackMatch || !attackMatch[1]) return undefined;

  const bonus = parseInt(attackMatch[1], 10);

  // Extract reach or range
  const reachMatch = normalized.match(/reach\s+(\d+)\s+ft/i);
  const reach = reachMatch && reachMatch[1] ? parseInt(reachMatch[1], 10) : undefined;

  const rangeMatch = normalized.match(/range\s+(\d+)\/(\d+)\s+ft|range\s+(\d+)\s+ft/i);
  const range = rangeMatch && (rangeMatch[1] || rangeMatch[3])
    ? {
        normal: parseInt((rangeMatch[3] || rangeMatch[1])!, 10),
        long: rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined,
      }
    : undefined;

  // Extract target specification: the clause right before ". Hit:", but only
  // if it actually names a target (e.g. "one target", "up to three targets") -
  // descriptions with no explicit target clause (just "reach 5 ft. Hit: ...")
  // must fall back to the default rather than capturing "ft" or similar.
  const targetsMatch = normalized.match(/,?\s*([^,.]*)\.\s*hit:/i);
  const targets =
    targetsMatch && targetsMatch[1] && /target/i.test(targetsMatch[1])
      ? targetsMatch[1].trim()
      : "one target";

  // Determine attack type
  let type: "melee" | "ranged" | "melee_ranged" = "melee";
  if (reach === undefined && range) type = "ranged";
  if (reach && range) type = "melee_ranged";

  // Extract damage
  const damage = parseDamage(description);

  return {
    name: extractActionName(description),
    type,
    bonus,
    reach,
    range,
    targets,
    damage,
  };
}

/**
 * Try to parse an action as a saving throw (2024 format).
 * Looks for patterns like "Wisdom Saving Throw: DC 12"
 */
export function parseSaveAction(description: string): ParsedSave | undefined {
  // Strip markdown formatting
  const normalized = stripMarkdown(description);

  // 2024 format: "Wisdom Saving Throw: DC 12"
  const saveMatch = normalized.match(
    /(\w+)\s+saving\s+throw:\s*dc\s+(\d+)/i
  );

  if (!saveMatch || !saveMatch[1] || !saveMatch[2]) return undefined;

  const ability = saveMatch[1];
  const dc = parseInt(saveMatch[2], 10);

  // Extract damage
  const damage = parseDamage(description);

  // Check for success effect: "... or half as much on a successful one" or
  // the labeled "Success: Half damage." form
  const successMatch =
    description.match(/,\s*or\s+([^.]+)\s+on\s+a\s+(?:successful|success)/i) ??
    description.match(/\bSuccess:\s*([^.\n]+)/i);
  const successEffect = successMatch ? successMatch[1] : undefined;

  return {
    name: extractActionName(description),
    dc,
    ability,
    damage,
    successEffect,
  };
}

/**
 * Extract the action name from the start of a description.
 * Looks for the bolded name that precedes the description text.
 */
function extractActionName(fullText: string): string {
  // Get the first word/phrase before a parenthesis, period, or colon - the
  // last of which covers the common "Melee Attack Roll: ..." / "Constitution
  // Saving Throw: ..." grammar phrasing.
  const nameMatch = fullText.match(/^([A-Za-z\s]+?)(?:\s*\(|\.|:)/);
  return nameMatch && nameMatch[1] ? nameMatch[1].trim() : "Unknown";
}

/**
 * Parse damage components from action text.
 * Handles patterns like:
 * - "10 (2d6 + 3) slashing damage"
 * - "plus 3 (1d6) necrotic damage"
 * - "or half as much on a successful one"
 */
function parseDamage(description: string): DamagePart[] {
  const damages: DamagePart[] = [];
  const seenRanges = new Set<string>(); // Track damage ranges we've already added to avoid duplicates

  // Pattern for main damage: "N (XdY ± Z) type damage"
  DAMAGE_PATTERN.lastIndex = 0;
  let match;
  while ((match = DAMAGE_PATTERN.exec(description)) !== null) {
    const formula = match[2]; // The "XdY ± Z" part
    const type = match[3];
    if (!formula || !type) continue;

    // Skip if this damage is preceded by "plus" (it will be handled by PLUS_PATTERN)
    const beforeMatch = description.substring(Math.max(0, match.index - 10), match.index);
    if (beforeMatch.match(/\bplus\s+\d+\s*\(\s*\w/)) {
      continue;
    }

    const damageKey = `${formula}|${type}`;
    if (seenRanges.has(damageKey)) continue;
    seenRanges.add(damageKey);

    const isAlternative = description.substring(0, match.index).match(/\bor\s+\d+\s*\(/);

    damages.push({
      formula,
      type: type.toLowerCase(),
      isAlternative: !!isAlternative,
    });
  }

  // Also check for "plus" pattern: "plus N (XdY ± Z) type damage"
  PLUS_PATTERN.lastIndex = 0;
  while ((match = PLUS_PATTERN.exec(description)) !== null) {
    const formula = match[2];
    const type = match[3];
    if (!formula || !type) continue;

    const damageKey = `${formula}|${type}`;
    if (seenRanges.has(damageKey)) continue;
    seenRanges.add(damageKey);

    damages.push({
      formula,
      type: type.toLowerCase(),
    });
  }

  return damages;
}

/**
 * Attempt to parse an action description into attack or save components.
 * Returns both if matched, or null if neither pattern matches.
 */
export function parseActionGrammar(
  action: StatblockData["actions"][0]
): {
  attack?: ParsedAttack;
  save?: ParsedSave;
} {
  const attack = parseAttackAction(action.description);
  const save = parseSaveAction(action.description);

  return { attack, save };
}

/**
 * Parse all actions and reactions from a statblock, extracting mechanical details.
 */
export function parseAllActionGrammar(statblock: StatblockData): {
  actions: Array<{
    name: string;
    type: "action" | "reaction" | "legendary" | "lair";
    attack?: ParsedAttack;
    save?: ParsedSave;
    recharge?: { value: number; charged: boolean };
  }>;
} {
  const results = statblock.actions.map((action) => {
    const { attack, save } = parseActionGrammar(action);
    return {
      name: action.name,
      type: action.type,
      attack,
      save,
      recharge: action.recharge,
    };
  });

  return { actions: results };
}
