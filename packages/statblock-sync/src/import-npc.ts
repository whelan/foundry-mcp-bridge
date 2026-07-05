/**
 * The "sync layer" that actually executes a match plan against a live (or
 * mock) world: Tier 1 clones the matched compendium entry via
 * `import_from_compendium`; anything else falls back to synthesizing an
 * actor with `statblockToFoundryActor` (Tier 3) and creating it directly.
 *
 * Kept decoupled from the bridge's transport/relay types (injected `deps`
 * instead) so this package stays usable standalone and mock-first testable —
 * see docs/obsidian-statblock-npc-sync-plan.md §5.
 *
 * Scope note: Tier 1 here is "exact name match, clone as-is" — it does not
 * yet diff the statblock against the compendium actor and patch deltas on
 * top (the design doc's fuller Tier 1 description). That patching is later
 * work; an exact SRD-name match today still gets the official, fully
 * mechanical actor, just without statblock-specific overrides applied.
 */

import type { CompendiumEntry } from "@foundry-mcp-bridge/shared";
import type { StatblockData } from "./schema.js";
import { statblockToFoundryActor, type Dnd5eActorDocument } from "./to-foundry.js";
import { matchStatblock } from "./match.js";

export interface ImportNpcResult {
  actorId: string;
  tier: 1 | 3;
  /** The compendium entry cloned, when `tier === 1`. */
  matchedUuid?: string;
}

export interface ImportNpcDeps {
  /** Search the world's compendia for actors matching `nameQuery`. */
  searchCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  /** Clone a compendium entry into the world, applying an optional patch. */
  importFromCompendium(uuid: string, patch?: Record<string, unknown>): Promise<{ _id: string }>;
  /** Create a synthesized document from scratch (Tier 3 fallback). */
  createDocument(data: Dnd5eActorDocument): Promise<{ _id: string }>;
}

/**
 * Import a parsed statblock into the world, preferring a Tier 1 compendium
 * clone over Tier 3 synthesis whenever the statblock's name exactly matches
 * an existing compendium actor — the "works like the official compendium
 * monster" goal (design doc §1).
 */
export async function importNpc(statblock: StatblockData, deps: ImportNpcDeps): Promise<ImportNpcResult> {
  const index = await deps.searchCompendium(statblock.data.name);
  const plan = matchStatblock(statblock, index);

  if (plan.tier === 1) {
    const doc = await deps.importFromCompendium(plan.uuid, plan.patch);
    return { actorId: doc._id, tier: 1, matchedUuid: plan.uuid };
  }

  const actorData = statblockToFoundryActor(statblock);
  const doc = await deps.createDocument(actorData);
  return { actorId: doc._id, tier: 3 };
}
