/**
 * Tier matching: decide whether a parsed statblock corresponds to an existing
 * compendium document (Tier 1, an exact clone) or needs synthesis from
 * scratch (Tier 3, the existing grammar-based converter in to-foundry.ts).
 *
 * See docs/obsidian-statblock-npc-sync-plan.md §1 for the full tier table.
 * This implements the Tier 1 / Tier 3 pair only — Tier 2 (per-item/trait
 * compendium matching) and Tier 4 (unparseable fallback) are later work; a
 * homebrew statblock with no exact compendium name match always falls
 * through to the existing Tier 3 synthesis path unchanged.
 */

import type { CompendiumEntry } from "@foundry-mcp-bridge/shared";
import type { StatblockData } from "./schema.js";

/**
 * `patch` is left unpopulated for now — this Tier 1 is "exact match, clone
 * as-is"; it does not yet diff the statblock against the compendium actor
 * and compute deltas (the design doc's fuller Tier 1 description, §1). The
 * field exists so that later work can attach a computed patch without a
 * breaking change to this shape or to import-npc.ts's call site.
 */
export type MatchPlan = { tier: 1; uuid: string; patch?: Record<string, unknown> } | { tier: 3 };

/**
 * Tier 1: an exact (case-insensitive, trimmed) name match against the
 * compendium index. Only an exact match is promoted automatically — fuzzy or
 * partial matches risk silently cloning the wrong monster, so anything short
 * of an exact match falls through to Tier 3 synthesis instead of guessing.
 */
export function matchStatblock(statblock: StatblockData, index: CompendiumEntry[]): MatchPlan {
  const name = statblock.data.name.trim().toLowerCase();
  const match = index.find((entry) => entry.name.trim().toLowerCase() === name);
  return match ? { tier: 1, uuid: match.uuid } : { tier: 3 };
}
