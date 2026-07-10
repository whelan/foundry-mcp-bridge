import { parseStatblock, parseStatblockRaw, parseAttackAction, parseSaveAction, statblockToFoundryActor, KNOWN_DAMAGE_TYPES } from "./index.js";

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

  // --- Trait lists: unrecognized damage-type tokens (typos, or a type that
  // didn't survive the Oxford-comma/qualifier-clause split as expected) -----
  const traitFields: Array<[string, string[]]> = [
    ["damage_resistances", statblock.traits.damageResistances],
    ["damage_immunities", statblock.traits.damageImmunities],
    ["damage_vulnerabilities", statblock.traits.damageVulnerabilities],
  ];
  for (const [field, values] of traitFields) {
    for (const v of values) {
      const known = KNOWN_DAMAGE_TYPES.has(v.trim().toLowerCase());
      const isQualifiedClause = /\bnonmagical\b|\bnon-magical\b|\bsilvered\b|\badamantine\b/i.test(v);
      if (!known && !isQualifiedClause) {
        findings.push({
          action: field,
          problem: `"${v}" isn't a recognized damage type and isn't a qualified clause (e.g. "...from nonmagical attacks") -- will land in free-text custom, not the mechanical list.`,
          severity: "WARN",
        });
      }
    }
  }

  // --- CR: must resolve to a real XP entry, not silently fall through to 0 -
  if (statblock.challenge.xp === 0 && statblock.challenge.cr !== 0) {
    findings.push({
      action: "cr",
      problem: `${(statblock as any).data.cr} did not resolve to a known XP value (got 0) -- check the CR format.`,
      severity: "FAIL",
    });
  }

  // --- Final sanity: the whole thing must actually convert without throwing
  try {
    statblockToFoundryActor(statblock);
  } catch (e) {
    findings.push({
      action: "(conversion)",
      problem: `statblockToFoundryActor threw: ${(e as any).message}`,
      severity: "FAIL",
    });
  }

  return findings;
}
