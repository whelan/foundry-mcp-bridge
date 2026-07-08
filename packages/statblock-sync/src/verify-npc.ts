/**
 * M5: Structured verification report for imported NPCs.
 *
 * Post-import verification that goes beyond the reliability pipeline's
 * subset check: reads the imported actor back from the world and verifies
 * mechanical correctness (to-hit, DC, abilities), image paths, and token art.
 */

import type { StatblockData } from "./schema.js";
import { getAbilityModifier, getProficiencyBonus } from "./math.js";
import { parseAttackAction, parseSaveAction } from "./grammar.js";
import { skillAbbrev, getSkillAbility, SENSE_RANGE_RE } from "./utils.js";

export interface VerificationCheck {
  name: string;
  pass: boolean;
  got?: unknown;
  want?: unknown;
}

export interface VerificationReport {
  ok: boolean;
  checks: VerificationCheck[];
}

export interface FoundryActorReadBack {
  _id: string;
  name: string;
  type: string;
  img?: string;
  prototypeToken?: { texture?: { src?: string } };
  system: Record<string, unknown>;
  items?: Array<{ name: string; type: string; system?: Record<string, unknown> }>;
}

/**
 * Verify an imported NPC against its source statblock.
 * Runs against live (or mock) world read-back, not the conversion output.
 */
export function verifyImportedNpc(
  readBack: FoundryActorReadBack,
  statblock: StatblockData,
  options?: { tokenizeMode?: boolean }
): VerificationReport {
  const checks: VerificationCheck[] = [];
  const system = readBack.system as Record<string, any>;

  // Basic actor metadata
  checks.push({
    name: "Actor exists with type 'npc'",
    pass: readBack.type === "npc",
    got: readBack.type,
    want: "npc",
  });

  checks.push({
    name: "Actor name matches",
    pass: readBack.name === statblock.data.name,
    got: readBack.name,
    want: statblock.data.name,
  });

  // Mechanical attributes
  const ac = (system.attributes?.ac as Record<string, any>)?.flat;
  checks.push({
    name: "AC matches",
    pass: ac === statblock.attributes.armorClass,
    got: ac,
    want: statblock.attributes.armorClass,
  });

  const hp = (system.attributes?.hp as Record<string, any>)?.max;
  checks.push({
    name: "HP matches",
    pass: hp === statblock.attributes.hitPoints.value,
    got: hp,
    want: statblock.attributes.hitPoints.value,
  });

  const cr = system.details?.cr;
  checks.push({
    name: "CR matches",
    pass: cr === statblock.challenge.cr,
    got: cr,
    want: statblock.challenge.cr,
  });

  // Ability scores
  const abilities = system.abilities as Record<string, any>;
  const abilityKeys = ["str", "dex", "con", "int", "wis", "cha"] as const;
  for (const key of abilityKeys) {
    const expected = statblock.abilities_[key];
    const actual = abilities?.[key]?.value;
    checks.push({
      name: `${key.toUpperCase()} score matches`,
      pass: actual === expected,
      got: actual,
      want: expected,
    });
  }

  // Item count (expect at least abilities + actions)
  const expectedItemCount = statblock.abilities.length + statblock.actions.length;
  const actualItemCount = readBack.items?.length ?? 0;
  checks.push({
    name: `Items created (≥${expectedItemCount})`,
    pass: actualItemCount >= expectedItemCount,
    got: actualItemCount,
    want: `>=${expectedItemCount}`,
  });

  // Attack/save verification: parse each action and check against items
  for (const action of statblock.actions) {
    const item = readBack.items?.find((i) => i.name === action.name);
    if (!item) {
      checks.push({
        name: `Action "${action.name}" created`,
        pass: false,
        got: undefined,
        want: "item",
      });
      continue;
    }

    const attackParsed = parseAttackAction(action.description);
    const saveParsed = parseSaveAction(action.description);

    const itemSystem = item.system as Record<string, any>;
    const activities = Object.values((itemSystem?.activities ?? {}) as Record<string, any>);

    if (attackParsed) {
      const attackAct = activities.find((a) => a.type === "attack");
      // Tier 1 clones of official monsters often use a calculated to-hit
      // (attack.flat: false, no static bonus stored — derived from ability +
      // proficiency at roll time) rather than our own Tier 3 emission's flat
      // numeric bonus. There's nothing static to compare in that case.
      if (attackAct && attackAct.attack?.flat !== true) {
        checks.push({
          name: `"${action.name}" attack activity present (calculated to-hit, not compared)`,
          pass: true,
          got: attackAct.attack?.bonus,
        });
      } else {
        const got = attackAct ? parseInt(String(attackAct.attack?.bonus ?? ""), 10) : undefined;
        checks.push({
          name: `"${action.name}" to-hit`,
          pass: got === attackParsed.bonus,
          got,
          want: attackParsed.bonus,
        });
      }
    }

    if (saveParsed) {
      const saveAct = activities.find((a) => a.type === "save");
      // Same as attack above: a calculated DC (dc.calculation set to an
      // ability key, formula like "8 + @mod + @prof") has no static number to
      // compare against the parsed statblock DC.
      if (saveAct && saveAct.save?.dc?.calculation) {
        checks.push({
          name: `"${action.name}" save activity present (calculated DC, not compared)`,
          pass: true,
          got: saveAct.save.dc.formula,
        });
      } else {
        const got = saveAct ? parseInt(String(saveAct.save?.dc?.formula ?? ""), 10) : undefined;
        checks.push({
          name: `"${action.name}" save DC`,
          pass: got === saveParsed.dc,
          got,
          want: saveParsed.dc,
        });
      }
    }

    if (action.recharge) {
      const recovery = (itemSystem?.uses?.recovery ?? []) as Array<Record<string, any>>;
      const got = recovery.find((r) => r.period === "recharge")?.formula;
      checks.push({
        name: `"${action.name}" recharge`,
        pass: got === String(action.recharge.value),
        got,
        want: String(action.recharge.value),
      });
    }
  }

  // Skill proficiencies (multiplier semantics, dnd5e 5.x)
  const skillsRB = system.skills as Record<string, any>;
  for (const p of statblock.skills.proficiencies) {
    const abbrev = skillAbbrev(p.skill);
    if (!abbrev) continue;
    const got = skillsRB?.[abbrev]?.value;
    checks.push({
      name: `Skill ${p.skill.toLowerCase()} proficient`,
      pass: typeof got === "number" && got >= 1,
      got,
      want: ">=1",
    });
    // The skill must roll off the right ability — dnd5e's SkillData default
    // is not per-skill, so an unwritten ability silently rolls off DEX (the
    // live M6b check showed Perception +4 instead of +3 because of this).
    const wantAbility = getSkillAbility(p.skill);
    const gotAbility = skillsRB?.[abbrev]?.ability;
    checks.push({
      name: `Skill ${p.skill.toLowerCase()} ability`,
      pass: gotAbility === wantAbility,
      got: gotAbility,
      want: wantAbility,
    });
  }

  // Save proficiencies
  for (const save of statblock.skills.savingThrows) {
    const key = save.ability.toLowerCase().substring(0, 3);
    const got = abilities?.[key]?.proficient;
    checks.push({
      name: `${key.toUpperCase()} save proficient`,
      pass: got === 1,
      got,
      want: 1,
    });
  }

  // Senses ranges
  const rangesRB = (system.attributes?.senses as Record<string, any>)?.ranges ?? {};
  for (const s of statblock.traits.senses) {
    const m = s.match(SENSE_RANGE_RE);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    const want = parseInt(m[2]!, 10);
    checks.push({
      name: `Senses: ${kind} ${want} ft`,
      pass: rangesRB[kind] === want,
      got: rangesRB[kind],
      want,
    });
  }

  // Image and token art
  if (statblock.data.image) {
    if (options?.tokenizeMode) {
      checks.push({
        name: "Actor image ends with .Avatar.webp (tokenizer mode)",
        pass: (readBack.img ?? "").endsWith(".Avatar.webp"),
        got: readBack.img,
      });

      checks.push({
        name: "Token texture ends with .Token.webp (tokenizer mode)",
        pass: (readBack.prototypeToken?.texture?.src ?? "").endsWith(".Token.webp"),
        got: readBack.prototypeToken?.texture?.src,
      });
    } else {
      checks.push({
        name: "Actor image is set",
        pass: !!readBack.img,
        got: readBack.img,
      });

      const tokenSrc = String(readBack.prototypeToken?.texture?.src ?? "");
      const actorImgStr = String(readBack.img ?? "");
      checks.push({
        name: "Token texture matches actor image",
        pass: tokenSrc === actorImgStr && tokenSrc.length > 0,
        got: tokenSrc || "(not set)",
        want: actorImgStr,
      });
    }
  }

  return {
    ok: checks.every((c) => c.pass),
    checks,
  };
}
