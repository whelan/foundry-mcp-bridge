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

/** D&D 5e skill name to dnd5e system abbreviation mapping */
export const SKILL_TO_ABBREVIATION_MAP: Record<string, string> = {
  acrobatics: "acr",
  "animal handling": "ani",
  arcana: "arc",
  athletics: "ath",
  deception: "dec",
  history: "his",
  insight: "ins",
  intimidation: "itm",
  investigation: "inv",
  medicine: "med",
  nature: "nat",
  perception: "prc",
  performance: "prf",
  persuasion: "per",
  religion: "rel",
  sleight: "slt",
  "sleight of hand": "slt",
  stealth: "ste",
  survival: "sur",
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

/** Cache for markdown section patterns to avoid RegExp recreation */
const traitPatternCache = new Map<string, RegExp>();

/** Get or create cached regex pattern for a markdown section label */
function getTraitPattern(label: string): RegExp {
  if (!traitPatternCache.has(label)) {
    traitPatternCache.set(label, new RegExp(`\\*\\*${label}\\*\\*\\s+([^\\n]+)`, "i"));
  }
  return traitPatternCache.get(label)!;
}

/** Parse a trait list (resistances, immunities, etc.) */
export function parseTraitList(body: string, label: string): string[] {
  const pattern = getTraitPattern(label);
  const match = body.match(pattern);
  return match && match[1] ? match[1].trim().split(",").map((s) => s.trim()) : [];
}

/** Normalize markdown formatting */
export function stripMarkdown(text: string): string {
  return text.replace(/\*+/g, "");
}

/** Get ability modifier for a skill name (encapsulates lowercase normalization) */
export function getSkillAbility(skill: string): string {
  return SKILL_TO_ABILITY_MAP[skill.toLowerCase()] || "str";
}
