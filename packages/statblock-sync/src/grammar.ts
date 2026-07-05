/**
 * M3: Action text grammar parser
 *
 * Parses attack, save, and other mechanics from action descriptions.
 * Handles both 2024 and 2014 grammar forms for compatibility.
 *
 * Example inputs:
 * - "Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 10 (2d6 + 3) slashing damage plus 3 (1d6) necrotic damage."
 * - "Each creature within 30 feet that can hear it must make a DC 13 Wisdom saving throw, taking 22 (4d10) psychic damage on a failed save, or half as much on a successful one."
 */

import type { StatblockData } from "./schema.js";
import { parseDamageFormula } from "./math.js";
import { DAMAGE_TYPES_STR, stripMarkdown } from "./utils.js";

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
 * Try to parse an action as a melee weapon attack.
 * Looks for patterns like "Melee Weapon Attack: +5 to hit, reach 5 ft., one target."
 */
export function parseAttackAction(description: string): ParsedAttack | undefined {
  // Strip markdown formatting (asterisks for italics/bold)
  const normalized = stripMarkdown(description);

  // Look for attack header
  const attackMatch = normalized.match(
    /(?:melee|ranged)?\s*weapon\s*attack:\s*([+-]\d+)\s+to\s+hit/i
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

  // Extract target specification - look for "one target" or similar after reach/range
  const targetsMatch = normalized.match(/(?:reach|range).*?(\w+(?:\s+\w+)*?)\s*\.\s*(?:hit|Hit|hit:)/i);
  const targets = targetsMatch && targetsMatch[1] ? targetsMatch[1].trim() : "one target";

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
 * Try to parse an action as a saving throw.
 * Looks for patterns like "DC 13 Wisdom saving throw" or "make a DC 13 Intelligence saving throw"
 */
export function parseSaveAction(description: string): ParsedSave | undefined {
  // Strip markdown formatting
  const normalized = stripMarkdown(description);

  // Look for save header
  const saveMatch = normalized.match(
    /(?:must\s+)?make\s+a?\s*dc\s+(\d+)\s+(\w+)\s+saving\s+throw/i
  );
  if (!saveMatch || !saveMatch[1] || !saveMatch[2]) return undefined;

  const dc = parseInt(saveMatch[1], 10);
  const ability = saveMatch[2];

  // Extract damage
  const damage = parseDamage(description);

  // Check for success effect
  const successMatch = description.match(
    /,\s*or\s+([^.]+)\s+on\s+a\s+(?:successful|success)/i
  );
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
  // This will be called after bold text is already stripped
  // Just get the first word/phrase before the parenthesis or period
  const nameMatch = fullText.match(/^([A-Za-z\s]+?)(?:\s*\(|\.)/);
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

  // Pattern for main damage: "N (XdY ± Z) type damage"
  const damagePattern = new RegExp(
    `(\\d+)\\s*\\(([^)]+)\\)\\s*(${DAMAGE_TYPES_STR})`,
    "gi"
  );

  let match;
  while ((match = damagePattern.exec(description)) !== null) {
    const formula = match[2]; // The "XdY ± Z" part
    const type = match[3];
    if (!formula || !type) continue;

    const isAlternative = description.substring(0, match.index).match(/\bor\s+\d+\s*\(/);

    damages.push({
      formula,
      type: type.toLowerCase(),
      isAlternative: !!isAlternative,
    });
  }

  // Also check for "plus" pattern: "plus N (XdY ± Z) type damage"
  const plusPattern = new RegExp(
    `plus\\s+(\\d+)\\s*\\(([^)]+)\\)\\s*(${DAMAGE_TYPES_STR})`,
    "gi"
  );
  while ((match = plusPattern.exec(description)) !== null) {
    const formula = match[2];
    const type = match[3];
    if (!formula || !type) continue;

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
