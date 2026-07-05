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

import type { StatblockData } from "./schema.js";

/** A compendium index entry, as returned by the bridge's `search_compendium`. */
export interface CompendiumIndexEntry {
  uuid: string;
  pack: string;
  name: string;
  type: string;
  cr?: number;
}

export type MatchPlan = { tier: 1; uuid: string } | { tier: 3 };

/**
 * Tier 1: an exact (case-insensitive, trimmed) name match against the
 * compendium index. Only an exact match is promoted automatically — fuzzy or
 * partial matches risk silently cloning the wrong monster, so anything short
 * of an exact match falls through to Tier 3 synthesis instead of guessing.
 */
export function matchStatblock(statblock: StatblockData, index: CompendiumIndexEntry[]): MatchPlan {
  const name = statblock.data.name.trim().toLowerCase();
  const match = index.find((entry) => entry.name.trim().toLowerCase() === name);
  return match ? { tier: 1, uuid: match.uuid } : { tier: 3 };
}
