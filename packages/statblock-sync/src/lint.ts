import { parseStatblock, parseStatblockRaw, parseAttackAction, parseSaveAction } from "./index.js";

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

  // --- Action-text grammar: the actual point of this lint -----------------
  // Check both abilities (from traits) and actions for 2014-style phrasing
  const allEntries = [...(statblock.abilities || []), ...(statblock.actions || [])];

  for (const entry of allEntries) {
    const attack = parseAttackAction(entry.description);
    const save = parseSaveAction(entry.description);
    const looksAttack = LOOKS_LIKE_ATTACK.test(entry.description);
    const looksSave = LOOKS_LIKE_SAVE.test(entry.description);

    if (looksAttack && !attack) {
      findings.push({
        action: entry.name,
        problem: `looks like an attack ("...attack roll...") but won't parse as 2024 grammar`,
        severity: "FAIL",
      });
    }
    if (looksSave && !save) {
      findings.push({
        action: entry.name,
        problem: `looks like a save ("...saving throw...") but won't parse as 2024 grammar`,
        severity: "FAIL",
      });
    }
  }

  return findings;
}
