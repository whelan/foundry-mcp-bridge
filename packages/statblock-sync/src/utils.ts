/**
 * Shared utilities and constants for statblock-sync.
 */

/** D&D 5e skill-to-ability mapping */
export const SKILL_TO_ABILITY_MAP: Record<string, string> = {
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
  "sleight of hand": "dex",
  stealth: "dex",
  survival: "wis",
};

/** Damage types recognized in D&D 5e */
export const DAMAGE_TYPES_STR =
  "slashing|piercing|bludgeoning|psychic|necrotic|fire|cold|lightning|radiant|acid|poison|thunder|force";

/** Helper to extract a regex group with fallback */
export function extractRegexGroup(
  text: string,
  pattern: RegExp,
  group = 1,
  defaultValue?: string
): string | undefined {
  return text.match(pattern)?.[group] ?? defaultValue;
}

/** Helper to extract an integer from regex match */
export function extractRegexInt(
  text: string,
  pattern: RegExp,
  group = 1,
  defaultValue = 0
): number {
  const val = extractRegexGroup(text, pattern, group);
  return val ? parseInt(val, 10) : defaultValue;
}

/** Parse a comma-separated list from a markdown section */
export function parseCommaList(
  body: string,
  label: string,
  parserFn?: (item: string) => unknown
): (string | unknown)[] {
  const pattern = new RegExp(`\\*\\*${label}\\*\\*\\s+([^\\n]+)`, "i");
  const match = body.match(pattern);
  if (!match || !match[1]) return [];

  const items = match[1].trim().split(",").map((s) => s.trim());
  return parserFn ? items.map(parserFn).filter(Boolean) : items;
}

/** Parse a trait list (resistances, immunities, etc.) */
export function parseTraitList(body: string, label: string): string[] {
  const pattern = new RegExp(`\\*\\*${label}\\*\\*\\s+([^\\n]+)`, "i");
  const match = body.match(pattern);
  return match && match[1] ? match[1].trim().split(",").map((s) => s.trim()) : [];
}

/** Normalize markdown formatting */
export function stripMarkdown(text: string): string {
  return text.replace(/\*+/g, "");
}
