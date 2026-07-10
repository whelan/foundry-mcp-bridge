/**
 * The "sync layer" that actually executes a match plan against a live (or
 * mock) world: Tier 1 clones the matched compendium entry via
 * `import_from_compendium`; anything else falls back to synthesizing an
 * actor with `statblockToFoundryActor` (Tier 3) and creating it directly.
 * After the actor exists (either tier), a spellcasting statblock's spell
 * list is resolved against the official `dnd5e.spells24` compendium (falling
 * back to the 2014 `dnd5e.spells` pack) and attached as embedded Items;
 * unmatched names get a minimal placeholder item instead of failing the
 * import (see docs/statblock-legendary-lair-spellcasting-plan.md, Part B).
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
  importFromCompendium(uuid: string, patch?: Record<string, unknown>, folderId?: string): Promise<{ _id: string }>;
  /** Create a synthesized document from scratch (Tier 3 fallback). */
  createDocument(data: Dnd5eActorDocument, folderId?: string): Promise<{ _id: string }>;
  /** Upload an image file and return the resolved remote path. */
  uploadImage?(filename: string, contentBase64: string, targetFolder?: string): Promise<string>;
  /** Search Item compendia (all packs) for a spell by name. */
  searchSpellCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  /** Clone a compendium Item as an embedded Item on the given actor. */
  importEmbeddedFromCompendium(parentId: string, uuid: string): Promise<{ _id: string }>;
  /** Create a literal (non-compendium) embedded Item on the given actor. */
  createEmbeddedItem(parentId: string, data: Record<string, unknown>): Promise<{ _id: string }>;
}

/**
 * Import a parsed statblock into the world, preferring a Tier 1 compendium
 * clone over Tier 3 synthesis whenever the statblock's name exactly matches
 * an existing compendium actor — the "works like the official compendium
 * monster" goal (design doc §1).
 */
export async function importNpc(
  statblock: StatblockData,
  deps: ImportNpcDeps,
  imageContent?: { filename: string; contentBase64: string },
  folderId?: string
): Promise<ImportNpcResult> {
  const index = await deps.searchCompendium(statblock.data.name);
  const plan = matchStatblock(statblock, index);

  let result: ImportNpcResult;
  if (plan.tier === 1) {
    const doc = await deps.importFromCompendium(plan.uuid, plan.patch, folderId);
    result = { actorId: doc._id, tier: 1, matchedUuid: plan.uuid };
  } else {
    // For Tier 3: upload image if provided, then use resolved path in actor data
    let resolvedImagePath: string | undefined;
    if (imageContent && deps.uploadImage) {
      resolvedImagePath = await deps.uploadImage(
        imageContent.filename,
        imageContent.contentBase64,
        `worlds/npcs/${statblock.data.name.replace(/\s+/g, "-").toLowerCase()}`
      );
    }

    const actorData = statblockToFoundryActor(statblock, resolvedImagePath);
    const doc = await deps.createDocument(actorData, folderId);
    result = { actorId: doc._id, tier: 3 };
  }

  if (statblock.spellcasting) {
    await attachSpells(statblock.spellcasting, result.actorId, deps);
  }

  return result;
}

/**
 * Resolve and attach each spell name in a parsed spellcasting block as an
 * embedded Item on the actor: exact-match (case-insensitive) against the
 * official `dnd5e.spells24` pack first, falling back to the 2014 `dnd5e.spells`
 * pack, and finally a minimal placeholder item (name only, default icon) so
 * a typo'd or homebrew spell name never fails the whole import.
 */
async function attachSpells(
  spellcasting: NonNullable<StatblockData["spellcasting"]>,
  actorId: string,
  deps: ImportNpcDeps
): Promise<void> {
  for (const level of spellcasting.levels) {
    for (const spellName of level.spellNames) {
      const results = await deps.searchSpellCompendium(spellName);
      const exactIn = (pack: string) =>
        results.find(
          (r) => r.pack === pack && r.name.toLowerCase() === spellName.toLowerCase()
        );
      const match = exactIn("dnd5e.spells24") ?? exactIn("dnd5e.spells");

      if (match) {
        await deps.importEmbeddedFromCompendium(actorId, match.uuid);
      } else {
        await deps.createEmbeddedItem(actorId, {
          name: spellName,
          type: "spell",
          img: "icons/svg/book.svg",
        });
      }
    }
  }
}
