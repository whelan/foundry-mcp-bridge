/**
 * Convert parsed statblocks to dnd5e Foundry actor JSON.
 *
 * This module takes a StatblockData and converts it to a Foundry actor document
 * suitable for import. It handles:
 * - Ability score derivation
 * - Skill and saving throw bonus calculation
 * - Item creation with activities (attacks, saves, damage)
 * - Embedded item structure
 *
 * Implemented in M4.
 */

import type { StatblockData } from "./schema.js";

export interface Dnd5eActorDocument {
  name: string;
  type: "npc" | "character";
  img?: string;
  system: Record<string, unknown>;
  items: Dnd5eItem[];
  effects: unknown[];
}

export interface Dnd5eItem {
  name: string;
  type: string;
  system?: Record<string, unknown>;
}

/**
 * Convert a parsed statblock to a Foundry dnd5e actor document.
 * Stub for M4 implementation.
 */
export function statblockToFoundryActor(statblock: StatblockData): Dnd5eActorDocument {
  throw new Error("M4: not yet implemented");
}
