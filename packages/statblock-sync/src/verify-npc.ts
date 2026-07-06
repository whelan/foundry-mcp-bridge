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

    if (attackParsed) {
      const itemSystem = item.system as Record<string, any>;
      const toHitFromItem = parseInt((itemSystem?.attack?.bonus ?? "") as string, 10);
      const strMod = getAbilityModifier(statblock.abilities_.str);
      const profBonus = getProficiencyBonus(statblock.challenge.cr);
      const expectedToHit = strMod + profBonus + attackParsed.bonus;

      checks.push({
        name: `"${action.name}" to-hit (ability + prof + parsed bonus)`,
        pass: toHitFromItem === expectedToHit,
        got: toHitFromItem,
        want: expectedToHit,
      });
    }

    if (saveParsed) {
      const itemSystem = item.system as Record<string, any>;
      const dcFromItem = (itemSystem?.save?.dc as Record<string, any>)?.value;

      checks.push({
        name: `"${action.name}" save DC`,
        pass: dcFromItem === saveParsed.dc,
        got: dcFromItem,
        want: saveParsed.dc,
      });
    }
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

      checks.push({
        name: "Token texture matches actor image",
        pass: readBack.prototypeToken?.texture?.src === readBack.img,
        got: readBack.prototypeToken?.texture?.src,
        want: readBack.img,
      });
    }
  }

  return {
    ok: checks.every((c) => c.pass),
    checks,
  };
}
