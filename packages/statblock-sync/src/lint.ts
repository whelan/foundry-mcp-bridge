import { parseStatblock, parseStatblockRaw, parseAttackAction, parseSaveAction, KNOWN_DAMAGE_TYPES } from "./index.js";

export interface LintFinding {
  action: string;
  problem: string;
  severity: "FAIL" | "WARN";
}

const LOOKS_LIKE_ATTACK = /\b(?:attack roll|weapon attack|spell attack)\b/i;
const LOOKS_LIKE_SAVE = /\bsaving throw\b/i;

/**
 * Lint a Fantasy Statblocks note's markdown against the 2024-only grammar.
 * Returns [] if clean, or an array of findings. Each FAIL means the action
 * will silently become a non-rollable feat on import.
 */
export function lintStatblockNote(markdown: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const { data: rawData } = parseStatblockRaw(markdown);

  // Silently skip files with no ```statblock fence at all
  if (Object.keys(rawData).length === 0) return findings;

  let statblock;
  try {
    statblock = parseStatblock(markdown);
  } catch (e) {
    // zod throws; summarize the issues
    if (Array.isArray((e as any).issues)) {
      for (const issue of (e as any).issues) {
        findings.push({
          action: `(schema)`,
          problem: issue.message,
          severity: "FAIL",
        });
      }
    } else {
      findings.push({
        action: "(parse)",
        problem: (e as any).message || "Unknown parse error",
        severity: "FAIL",
      });
    }
    return findings;
  }

  // Check each action in traits and actions for 2014-style phrasing
  for (const trait of statblock.abilities || []) {
    const looksFail = LOOKS_LIKE_SAVE.test(trait.description) && !parseSaveAction(trait.description);
    if (looksFail) {
      findings.push({
        action: trait.name,
        problem: `looks like a save ("...saving throw...") but won't parse as 2024 grammar`,
        severity: "FAIL",
      });
    }

    const looksAttack = LOOKS_LIKE_ATTACK.test(trait.description) && !parseAttackAction(trait.description);
    if (looksAttack) {
      findings.push({
        action: trait.name,
        problem: `looks like an attack ("...attack roll...") but won't parse as 2024 grammar`,
        severity: "FAIL",
      });
    }
  }

  return findings;
}
