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
import { statblockKey } from "./slug.js";

export interface ImportNpcResult {
  actorId: string;
  tier: 1 | 3;
  /** The compendium entry cloned, when `tier === 1`. */
  matchedUuid?: string;
  /** Whether the actor was created or updated. */
  action: "created" | "updated";
  /** Summary of item changes during upsert (create/update/delete/unchanged counts). */
  itemChanges?: { created: number; updated: number; deleted: number; unchanged: number };
}

export interface ImportNpcDeps {
  /** Search the world's compendia for actors matching `nameQuery`. */
  searchCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  /** Clone a compendium entry into the world, applying an optional patch. */
  importFromCompendium(uuid: string, patch?: Record<string, unknown>, folderId?: string): Promise<{ _id: string }>;
  /** Create a synthesized document from scratch (Tier 3 fallback). */
  createDocument(data: Dnd5eActorDocument): Promise<{ _id: string }>;
  /** Upload an image file and return the resolved remote path. */
  uploadImage?(filename: string, contentBase64: string, targetFolder?: string): Promise<string>;
  /** Search Item compendia (all packs) for a spell by name. */
  searchSpellCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  /** Clone a compendium Item as an embedded Item on the given actor. */
  importEmbeddedFromCompendium(parentId: string, uuid: string): Promise<{ _id: string }>;
  /** Create a literal (non-compendium) embedded Item on the given actor. */
  createEmbeddedItem(parentId: string, data: Record<string, unknown>): Promise<{ _id: string }>;
  /** Find actors by their statblockKey flag. */
  findActorsByKey(key: string): Promise<{ _id: string }[]>;
  /** Update an actor document by ID. */
  updateDocument(actorId: string, patch: Record<string, unknown>): Promise<{ _id: string }>;
  /** Find all items on an actor. */
  findActorItems(actorId: string): Promise<Array<{ _id: string; name: string; type: string; flags?: Record<string, any> }>>;
  /** Update an embedded item on an actor. */
  updateEmbeddedItem(actorId: string, itemId: string, patch: Record<string, unknown>): Promise<{ _id: string }>;
  /** Delete an embedded item from an actor. */
  deleteEmbeddedItem(actorId: string, itemId: string): Promise<{ _id: string }>;
}

/**
 * Import a parsed statblock into the world, with support for upsert (update-or-create).
 *
 * Modes:
 * - "upsert" (default): Match found → update; no match → create
 * - "create": Always creates, even if match exists (for intentional duplicates)
 * - "update": Requires match; error if none found
 *
 * When updating (Tier 3 only), builds a patch of statblock-owned fields and diffs
 * tool-created items by key: matched items updated, new items created, removed items
 * deleted, GM-added unflagged items preserved.
 *
 * Tier 1 (compendium clone) always creates and skips item diffing; spells are
 * attached after actor exists.
 */
export async function importNpc(
  statblock: StatblockData,
  deps: ImportNpcDeps,
  imageContent?: { filename: string; contentBase64: string },
  folderId?: string,
  mode: "upsert" | "create" | "update" = "upsert",
  matchedActorId?: string
): Promise<ImportNpcResult> {
  const key = statblockKey(statblock.data.name);

  // Determine if this is a create or update path
  let actorId: string;
  let action: "created" | "updated";
  let result: ImportNpcResult;

  // If no explicit match provided, query for one (unless mode is "create")
  if (!matchedActorId && mode !== "create") {
    const matches = await deps.findActorsByKey(key);
    if (matches.length > 1) {
      throw Object.assign(new Error(`Ambiguous match: ${matches.length} actors with key "${key}"`), {
        code: "VALIDATION",
        details: { matchedActorIds: matches.map(m => m._id) },
        stage: "match-query",
      });
    }
    if (matches.length === 1) {
      matchedActorId = matches[0]!._id;
    }
  }

  // Validate mode constraints
  if (mode === "update" && !matchedActorId) {
    throw Object.assign(new Error(`mode: "update" requires an existing actor with key "${key}"`), {
      code: "VALIDATION",
      details: { statblockKey: key },
      stage: "mode-validation",
    });
  }

  // UPDATE PATH
  if (matchedActorId && (mode === "upsert" || mode === "update")) {
    try {
      // Build patch of statblock-owned fields only
      let resolvedImagePath: string | undefined;
      if (imageContent && deps.uploadImage) {
        try {
          resolvedImagePath = await deps.uploadImage(
            imageContent.filename,
            imageContent.contentBase64,
            `worlds/npcs/${statblock.data.name.replace(/\s+/g, "-").toLowerCase()}`
          );
        } catch (e) {
          const err = e as any;
          err.actorId = undefined;
          err.stage = "uploadImage";
          throw err;
        }
      }

      const patch = buildNpcUpdatePatch(statblock, resolvedImagePath, folderId);
      const updateResult = await deps.updateDocument(matchedActorId, patch);
      actorId = updateResult._id;
      action = "updated";
      result = { actorId, tier: 3, action };
    } catch (e) {
      const err = e as any;
      if (!err.stage) {
        err.stage = "actor-update";
      }
      if (!("actorId" in err)) {
        err.actorId = matchedActorId;
      }
      throw err;
    }

    // Item diffing for upsert (Tier 3 only for v1)
    try {
      const itemChanges = await diffAndApplyItems(
        matchedActorId,
        statblock,
        deps
      );
      result.itemChanges = itemChanges;
    } catch (e) {
      const err = e as any;
      err.actorId = actorId;
      err.stage = "itemDiff";
      throw err;
    }

    // Attach spells if needed
    try {
      if (statblock.spellcasting) {
        await attachSpells(statblock.spellcasting, actorId, deps);
      }
    } catch (e) {
      const err = e as any;
      err.actorId = actorId;
      err.stage = "attachSpells";
      throw err;
    }

    return result;
  }

  // CREATE PATH (mode is "create" or upsert with no match)
  try {
    const index = await deps.searchCompendium(statblock.data.name);
    const plan = matchStatblock(statblock, index);

    if (plan.tier === 1) {
      const doc = await deps.importFromCompendium(plan.uuid, plan.patch, folderId);
      actorId = doc._id;
      action = "created";
      result = { actorId, tier: 1, matchedUuid: plan.uuid, action };
    } else {
      let resolvedImagePath: string | undefined;
      if (imageContent && deps.uploadImage) {
        try {
          resolvedImagePath = await deps.uploadImage(
            imageContent.filename,
            imageContent.contentBase64,
            `worlds/npcs/${statblock.data.name.replace(/\s+/g, "-").toLowerCase()}`
          );
        } catch (e) {
          const err = e as any;
          err.actorId = undefined;
          err.stage = "uploadImage";
          throw err;
        }
      }

      const actorData = statblockToFoundryActor(statblock, resolvedImagePath);
      if (folderId) {
        actorData.folder = folderId;
      }
      const doc = await deps.createDocument(actorData);
      actorId = doc._id;
      action = "created";
      result = { actorId, tier: 3, action };
    }
  } catch (e) {
    const err = e as any;
    if (!err.stage) {
      err.stage = "actor-create";
    }
    if (!("actorId" in err)) {
      err.actorId = undefined;
    }
    throw err;
  }

  // Attach spells
  try {
    if (statblock.spellcasting) {
      await attachSpells(statblock.spellcasting, actorId, deps);
    }
  } catch (e) {
    const err = e as any;
    err.actorId = actorId;
    err.stage = "attachSpells";
    throw err;
  }

  return result;
}

/**
 * Build a dot-notation patch for updating an existing actor with freshly
 * parsed statblock data. Only includes statblock-owned fields (name, AC, HP max,
 * abilities, CR, skills, saves, spell slots, resources, languages, traits).
 * Preserves Foundry-owned runtime state (current HP, effects, token, exhaustion,
 * currency, _stats, ownership).
 *
 * The patch is ready to pass to updateDocumentReliable's dry-run → write →
 * read-back → rollback pipeline.
 */
export function buildNpcUpdatePatch(
  statblock: StatblockData,
  resolvedImagePath?: string,
  folderId?: string
): Record<string, unknown> {
  // Synthesize a fresh actor to extract statblock-owned fields
  const fresh = statblockToFoundryActor(statblock, resolvedImagePath);
  const sys = fresh.system as Record<string, any>;

  // Build the patch by selecting only statblock-owned paths
  const patch: Record<string, unknown> = {};

  // Top-level fields
  patch.name = fresh.name;
  if (resolvedImagePath) {
    patch.img = fresh.img;
  }

  // System fields — statblock-owned subset
  const attributes = sys.attributes as Record<string, any>;
  patch["system.attributes.ac.flat"] = attributes.ac?.flat;
  patch["system.attributes.ac.calc"] = attributes.ac?.calc;
  patch["system.attributes.hp.max"] = attributes.hp?.max;
  patch["system.attributes.hp.formula"] = attributes.hp?.formula;
  patch["system.attributes.movement"] = attributes.movement;
  patch["system.attributes.senses"] = attributes.senses;

  // Abilities (values only, not bonuses or proficiency state)
  const abilities = sys.abilities as Record<string, any>;
  for (const ability of ["str", "dex", "con", "int", "wis", "cha"] as const) {
    const abilityData = abilities[ability] as Record<string, any>;
    patch[`system.abilities.${ability}.value`] = abilityData?.value;
    patch[`system.abilities.${ability}.proficient`] = abilityData?.proficient ?? 0;
  }

  // Details
  const details = sys.details as Record<string, any>;
  patch["system.details.cr"] = details.cr;
  patch["system.details.alignment"] = details.alignment;
  patch["system.details.type"] = details.type;

  // Traits
  const traits = sys.traits as Record<string, any>;
  patch["system.traits.size"] = traits.size;
  patch["system.traits.languages"] = traits.languages;
  patch["system.traits.dr"] = traits.dr;
  patch["system.traits.di"] = traits.di;
  patch["system.traits.dv"] = traits.dv;
  patch["system.traits.ci"] = traits.ci;

  // Skills (proficiency + ability, not derived bonuses)
  const skills = sys.skills as Record<string, any>;
  for (const [key, val] of Object.entries(skills)) {
    patch[`system.skills.${key}`] = val;
  }

  // Resources
  const resources = sys.resources as Record<string, any>;
  patch["system.resources.legact"] = resources.legact;
  patch["system.resources.legres"] = resources.legres;
  patch["system.resources.lair"] = resources.lair;

  // Spells (slot counts, not spent)
  const spells = sys.spells as Record<string, any> | undefined;
  if (spells) {
    for (let level = 1; level <= 9; level++) {
      const key = `spell${level}`;
      if (key in spells) {
        patch[`system.spells.${key}`] = spells[key];
      }
    }
    if ("pact" in spells) {
      patch["system.spells.pact"] = spells.pact;
    }
  }

  // Folder (only if provided)
  if (folderId) {
    patch.folder = folderId;
  }

  return patch;
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

/**
 * Diff tool-created items (those with statblockKey flags) on an actor against
 * a fresh statblock synthesis. Matched items are updated in-place (preserving _id),
 * new items are created, removed items are deleted, and GM-added unflagged items
 * are preserved.
 *
 * Returns a summary of changes: { created, updated, deleted, unchanged }.
 */
async function diffAndApplyItems(
  actorId: string,
  statblock: StatblockData,
  deps: ImportNpcDeps
): Promise<{ created: number; updated: number; deleted: number; unchanged: number }> {
  // Fetch current items
  const currentItems = await deps.findActorItems(actorId);

  // Synthesize fresh item list
  const freshActor = statblockToFoundryActor(statblock);
  const freshItems = freshActor.items;

  // Partition current items by flag presence
  const flaggedItems = currentItems.filter(i => i.flags?.["foundry-mcp-bridge"]?.statblockKey);
  const unflaggedItems = currentItems.filter(i => !i.flags?.["foundry-mcp-bridge"]?.statblockKey);

  // Build maps for diffing
  const currentByKey = new Map(
    flaggedItems.map(i => [i.flags!["foundry-mcp-bridge"]!.statblockKey, i])
  );
  const freshByKey = new Map(
    freshItems.map(i => [i.flags?.["foundry-mcp-bridge"]?.statblockKey, i])
  );

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  // Create new items (fresh key not in current)
  for (const [freshKey, freshItem] of freshByKey) {
    if (!freshKey || currentByKey.has(freshKey)) continue;
    await deps.createEmbeddedItem(actorId, freshItem as any);
    created++;
  }

  // Update matched items (key in both current and fresh)
  for (const [currentKey, currentItem] of currentByKey) {
    const freshItem = freshByKey.get(currentKey);
    if (!freshItem) continue; // Delete handled below

    if (currentItem.name === freshItem.name) {
      // No name change, just check if system/img changed
      const changed = JSON.stringify(currentItem) !== JSON.stringify(freshItem);
      if (changed) {
        // Build minimal patch: name, img, system
        const patch = {
          name: freshItem.name,
          img: freshItem.img,
          system: freshItem.system,
        };
        await deps.updateEmbeddedItem(actorId, currentItem._id, patch);
        updated++;
      } else {
        unchanged++;
      }
    } else {
      // Name changed, update it
      const patch = {
        name: freshItem.name,
        img: freshItem.img,
        system: freshItem.system,
      };
      await deps.updateEmbeddedItem(actorId, currentItem._id, patch);
      updated++;
    }
  }

  // Delete removed items (current key not in fresh, and flagged)
  for (const [currentKey, currentItem] of currentByKey) {
    if (!freshByKey.has(currentKey)) {
      await deps.deleteEmbeddedItem(actorId, currentItem._id);
      deleted++;
    }
  }

  return { created, updated, deleted, unchanged };
}
