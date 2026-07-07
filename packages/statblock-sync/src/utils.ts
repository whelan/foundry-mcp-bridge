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

/** `DAMAGE_TYPES_STR` as a Set, for O(1) "is this a known damage type" checks. */
export const KNOWN_DAMAGE_TYPES = new Set(DAMAGE_TYPES_STR.split("|"));

/** Matches "darkvision 60 ft." style sense clauses; group 1 = kind, group 2 = range in feet. */
export const SENSE_RANGE_RE = /(darkvision|blindsight|tremorsense|truesight)\s+(\d+)\s*ft/i;

/** D&D 5e size name to dnd5e system size code mapping */
export const SIZE_TO_ABBREVIATION_MAP: Record<string, string> = {
  tiny: "tiny",
  small: "sm",
  medium: "med",
  large: "lg",
  huge: "huge",
  gargantuan: "grg",
};

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

/** Look up a skill's dnd5e abbreviation by its full name (e.g. "Sleight of Hand" -> "slt"). */
export function skillAbbrev(skill: string): string | undefined {
  return SKILL_TO_ABBREVIATION_MAP[skill.toLowerCase().replace(/ of hand/, "")];
}
