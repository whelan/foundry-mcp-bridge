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

import { isSubset, type CompendiumEntry, type CompendiumDocument, type CompendiumDocumentItem } from "@foundry-mcp-bridge/shared";
import type { StatblockData } from "./schema.js";
import { statblockToFoundryActor, type Dnd5eActorDocument, type Dnd5eItem } from "./to-foundry.js";
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
  /** Read a compendium document's full data (system + items with per-item uuids). */
  getCompendiumDocument(uuid: string): Promise<CompendiumDocument>;
  /** Create a synthesized document from scratch (Tier 3 fallback). */
  createDocument(data: Dnd5eActorDocument): Promise<{ _id: string }>;
  /** Upload an image file and return the resolved remote path. */
  uploadImage?(filename: string, contentBase64: string, targetFolder?: string): Promise<string>;
  /** Search Item compendia (all packs) for a spell by name. */
  searchSpellCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  /** Clone a compendium Item as an embedded Item on the given actor. */
  importEmbeddedFromCompendium(parentId: string, uuid: string, patch?: Record<string, unknown>): Promise<{ _id: string }>;
  /** Create a literal (non-compendium) embedded Item on the given actor. */
  createEmbeddedItem(parentId: string, data: Record<string, unknown>): Promise<{ _id: string }>;
  /** Find actors by their statblockKey flag, returning each actor's flags for tier dispatch. */
  findActorsByKey(key: string): Promise<Array<{ _id: string; flags?: Record<string, any> }>>;
  /** Update an actor document by ID. */
  updateDocument(actorId: string, patch: Record<string, unknown>): Promise<{ _id: string }>;
  /** Find all items on an actor. */
  findActorItems(actorId: string): Promise<Array<{ _id: string; name: string; type: string; img?: string; system?: any; flags?: Record<string, any>; _stats?: Record<string, any> }>>;
  /** Update an embedded item on an actor. */
  updateEmbeddedItem(actorId: string, itemId: string, patch: Record<string, unknown>): Promise<{ _id: string }>;
  /** Delete an embedded item from an actor. */
  deleteEmbeddedItem(actorId: string, itemId: string): Promise<{ _id: string }>;
}

/**
 * Determine the tier of a matched actor for update routing. Checks the actor's
 * foundry-mcp-bridge flags for explicit tier 1 marker (compendiumUuid); if not
 * present, infers tier via legacy compendium exact-match. Falls back to Tier 3.
 */
async function resolveMatchedTier(
  matched: { _id: string; flags?: Record<string, any> },
  statblock: StatblockData,
  deps: ImportNpcDeps,
): Promise<{ tier: 1; compendiumUuid: string } | { tier: 3 }> {
  const flag = matched.flags?.["foundry-mcp-bridge"];
  if (flag?.tier === 3) return { tier: 3 };
  if (flag?.tier === 1 && typeof flag.compendiumUuid === "string") {
    return { tier: 1, compendiumUuid: flag.compendiumUuid };
  }
  // Legacy: infer via compendium exact-match
  const index = await deps.searchCompendium(statblock.data.name);
  const plan = matchStatblock(statblock, index);
  return plan.tier === 1 ? { tier: 1, compendiumUuid: plan.uuid } : { tier: 3 };
}

/**
 * Refresh a Tier 1 actor from its compendium source: reads fresh compendium data,
 * builds and applies the refresh patch (preserving runtime state), backfills flags
 * for legacy actors, and syncs items (create/update/delete/adopt).
 */
async function refreshTier1(
  actorId: string,
  compendiumUuid: string,
  statblock: StatblockData,
  deps: ImportNpcDeps,
  imageContent: { filename: string; contentBase64: string } | undefined,
  folderId: string | undefined,
): Promise<ImportNpcResult> {
  let fresh: CompendiumDocument;
  try {
    fresh = await deps.getCompendiumDocument(compendiumUuid);
  } catch (e) {
    const err = e as any;
    throw Object.assign(
      new Error(`Tier 1 refresh: compendium document ${compendiumUuid} could not be read`),
      {
        code: err.code ?? "VALIDATION",
        details: { compendiumUuid },
        stage: "compendium-read",
        actorId,
        cause: err.message ?? String(e),
      },
    );
  }

  try {
    const resolvedImagePath = await resolveImagePath(statblock, imageContent, deps);
    const patch = buildCompendiumRefreshPatch(fresh, resolvedImagePath, folderId);
    // Backfill tier/compendiumUuid for legacy actors on upgrade
    patch["flags.foundry-mcp-bridge.tier"] = 1;
    patch["flags.foundry-mcp-bridge.compendiumUuid"] = compendiumUuid;
    await deps.updateDocument(actorId, patch);
  } catch (e) {
    const err = e as any;
    if (!err.stage) err.stage = "actor-update";
    if (err.actorId === undefined) err.actorId = actorId;
    throw err;
  }

  let itemChanges;
  try {
    itemChanges = await refreshCompendiumItems(actorId, fresh, deps);
  } catch (e) {
    const err = e as any;
    err.actorId = actorId;
    err.stage = "itemDiff";
    throw err;
  }

  return { actorId, tier: 1, matchedUuid: compendiumUuid, action: "updated", itemChanges };
}

/**
 * Diff and sync embedded items for a Tier 1 actor refresh. Matches current items
 * by sourceUuid flag, compendiumSource, or name; creates fresh items with no
 * counterpart; updates matched items; deletes flagged items whose source disappeared;
 * preserves unflagged (GM-added) items.
 */
async function refreshCompendiumItems(
  actorId: string,
  fresh: CompendiumDocument,
  deps: ImportNpcDeps,
): Promise<{ created: number; updated: number; deleted: number; unchanged: number }> {
  const currentItems = await deps.findActorItems(actorId);
  const freshByUuid = new Map(fresh.items.map((i) => [i.uuid, i]));
  const claimed = new Map<string, { _id: string; name: string; img?: string; system?: any; hadFlag: boolean }>();

  // First, match by our sourceUuid flag. An item whose source has disappeared
  // from the compendium is deliberately left unclaimed here (not added to
  // `claimed`) so it falls through to the "delete" loop below instead of
  // reaching the update loop, which assumes every claimed uuid still exists
  // in freshByUuid.
  for (const it of currentItems) {
    const src = it.flags?.["foundry-mcp-bridge"]?.sourceUuid;
    if (typeof src === "string" && freshByUuid.has(src) && !claimed.has(src)) {
      claimed.set(src, { _id: it._id, name: it.name, img: it.img, system: it.system, hadFlag: true });
    }
  }

  // Legacy adoption: match unflagged items (predate the sourceUuid provenance
  // stamp) by compendiumSource, or by name as a last resort. Name-matching is
  // ambiguous when two items share a display name (e.g. two distinct "Claw"
  // attacks) -- adopting the first match in iteration order would silently
  // cross-wire their mechanics, so name-matching only fires when the current
  // item's name is unique among both the unflagged legacy items being adopted
  // and the still-unclaimed fresh items; an ambiguous name is left unadopted
  // (the legacy item stays untouched, and its fresh counterpart is created
  // fresh alongside it rather than guessing which one it replaces).
  const unflaggedNameCounts = new Map<string, number>();
  for (const it of currentItems) {
    if (it.flags?.["foundry-mcp-bridge"]?.sourceUuid) continue;
    unflaggedNameCounts.set(it.name, (unflaggedNameCounts.get(it.name) ?? 0) + 1);
  }

  for (const it of currentItems) {
    if (it.flags?.["foundry-mcp-bridge"]?.sourceUuid) continue;
    const bySource = it._stats?.compendiumSource;
    let matchUuid: string | undefined;
    if (typeof bySource === "string" && freshByUuid.has(bySource) && !claimed.has(bySource)) {
      matchUuid = bySource;
    } else if (unflaggedNameCounts.get(it.name) === 1) {
      let nameMatches = 0;
      let candidate: string | undefined;
      for (const [uuid, f] of freshByUuid) {
        if (!claimed.has(uuid) && f.name === it.name) {
          nameMatches++;
          candidate = uuid;
        }
      }
      if (nameMatches === 1) matchUuid = candidate;
    }
    if (matchUuid) {
      claimed.set(matchUuid, { _id: it._id, name: it.name, img: it.img, system: it.system, hadFlag: false });
    }
  }

  let created = 0, updated = 0, deleted = 0, unchanged = 0;

  // Create fresh items with no claimed counterpart
  for (const [uuid, item] of freshByUuid) {
    if (claimed.has(uuid)) continue;
    await deps.createEmbeddedItem(actorId, buildTier1Item(item) as unknown as Record<string, unknown>);
    created++;
  }

  // Update (or adopt+stamp) claimed items
  for (const [uuid, current] of claimed) {
    const item = freshByUuid.get(uuid)!;
    const patch = buildTier1ItemPatch(item) as Record<string, any>;
    if (!current.hadFlag) {
      patch.flags = { "foundry-mcp-bridge": { sourceUuid: uuid } };
    }
    const changed =
      current.hadFlag === false ||
      current.name !== item.name ||
      current.img !== item.img ||
      !isSubset(current.system, patch.system);
    if (changed) {
      await deps.updateEmbeddedItem(actorId, current._id, patch);
      updated++;
    } else {
      unchanged++;
    }
  }

  // Delete flagged items whose source disappeared
  for (const it of currentItems) {
    const src = it.flags?.["foundry-mcp-bridge"]?.sourceUuid;
    if (typeof src === "string" && !freshByUuid.has(src)) {
      await deps.deleteEmbeddedItem(actorId, it._id);
      deleted++;
    }
  }

  return { created, updated, deleted, unchanged };
}

/**
 * Import a parsed statblock into the world, with support for upsert (update-or-create).
 *
 * Modes:
 * - "upsert" (default): Match found → update; no match → create
 * - "create": Always creates, even if match exists (for intentional duplicates)
 * - "update": Requires match; error if none found
 *
 * When updating (Tier 1), refreshes from compendium data and syncs items.
 * When updating (Tier 3), builds a patch of statblock-owned fields and diffs
 * tool-created items by key: matched items updated, new items created, removed items
 * deleted, GM-added unflagged items preserved.
 *
 * Tier 1 (compendium clone) creates or updates via compendium refresh.
 * Spells are attached after actor exists.
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
  let matchedActor: { _id: string; flags?: Record<string, any> } | undefined;
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
      matchedActor = matches[0]!;
      matchedActorId = matchedActor._id;
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
    // A caller may pass matchedActorId directly (e.g. to resolve an earlier
    // "Ambiguous match" error's matchedActorIds), bypassing the
    // findActorsByKey lookup above -- in that case matchedActor's flags
    // still need fetching, since resolveMatchedTier depends on them to route
    // Tier 1 vs Tier 3. Without this, a directly-passed Tier 1 actor id would
    // silently fall through to the Tier 3 synthesis-diff path below.
    if (!matchedActor) {
      const matches = await deps.findActorsByKey(key);
      matchedActor = matches.find((m) => m._id === matchedActorId);
    }
    if (matchedActor) {
      const resolved = await resolveMatchedTier(matchedActor, statblock, deps);
      if (resolved.tier === 1) {
        return await refreshTier1(
          matchedActorId,
          resolved.compendiumUuid,
          statblock,
          deps,
          imageContent,
          folderId,
        );
      }
    }

    // Tier 3: existing synthesis-diff path (unchanged)
    try {
      const resolvedImagePath = await resolveImagePath(statblock, imageContent, deps);
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
      if (err.actorId === undefined) {
        err.actorId = matchedActorId;
      }
      throw err;
    }

    // Item diffing for upsert (Tier 3 only for v1)
    let preDiffItems: Array<{ _id: string; flags?: Record<string, any> }> = [];
    try {
      const { currentItems, ...itemChanges } = await diffAndApplyItems(
        matchedActorId,
        statblock,
        deps
      );
      result.itemChanges = itemChanges;
      preDiffItems = currentItems;
    } catch (e) {
      const err = e as any;
      err.actorId = actorId;
      err.stage = "itemDiff";
      throw err;
    }

    await attachSpellsTagged(statblock, actorId, deps, preDiffItems);
    return result;
  }

  // CREATE PATH (mode is "create" or upsert with no match)
  try {
    const index = await deps.searchCompendium(statblock.data.name);
    const plan = matchStatblock(statblock, index);

    if (plan.tier === 1) {
      const fresh = await deps.getCompendiumDocument(plan.uuid);
      const resolvedImagePath = await resolveImagePath(statblock, imageContent, deps);
      const actorData = buildTier1ActorData(fresh, key, plan.uuid, folderId, resolvedImagePath);
      const doc = await deps.createDocument(actorData as Dnd5eActorDocument);
      actorId = doc._id;
      action = "created";
      result = { actorId, tier: 1, matchedUuid: plan.uuid, action };
      return result; // Early return — don't run attachSpells for Tier 1
    } else {
      const resolvedImagePath = await resolveImagePath(statblock, imageContent, deps);
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

  await attachSpellsTagged(statblock, actorId, deps);
  return result;
}

/** Upload the NPC's portrait image, if provided, tagging upload failures for the outer error handler. */
async function resolveImagePath(
  statblock: StatblockData,
  imageContent: { filename: string; contentBase64: string } | undefined,
  deps: ImportNpcDeps
): Promise<string | undefined> {
  if (!imageContent || !deps.uploadImage) return undefined;
  try {
    return await deps.uploadImage(
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

/** Attach the statblock's spell list (if any) to the actor, tagging failures with actorId/stage. */
async function attachSpellsTagged(
  statblock: StatblockData,
  actorId: string,
  deps: ImportNpcDeps,
  currentItems: Array<{ _id: string; flags?: Record<string, any> }> = []
): Promise<void> {
  try {
    if (statblock.spellcasting) {
      await attachSpells(statblock.spellcasting, actorId, deps, currentItems);
    }
  } catch (e) {
    const err = e as any;
    err.actorId = actorId;
    err.stage = "attachSpells";
    throw err;
  }
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
 * Build a dot-notation patch for refreshing an existing Tier 1 actor from
 * compendium data. Strips runtime leaves (HP current, exhaustion, currency)
 * so deep-merge preserves them, includes all compendium-owned fields.
 */
export function buildCompendiumRefreshPatch(
  fresh: CompendiumDocument,
  resolvedImagePath?: string,
  folderId?: string
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  // Top-level fields
  patch.name = fresh.name;
  if (resolvedImagePath) {
    patch.img = resolvedImagePath;
  }

  // Deep clone system to avoid mutations
  const sys = structuredClone(fresh.system) as Record<string, any>;

  // Strip runtime leaves from attributes
  const attributes = sys.attributes as Record<string, any> | undefined;
  if (attributes?.hp) {
    delete attributes.hp.value;
    delete attributes.hp.temp;
    delete attributes.hp.tempmax;
  }
  if (attributes) {
    delete attributes.exhaustion;
  }
  delete sys.currency;

  patch.system = sys;

  // Folder (only if provided)
  if (folderId) {
    patch.folder = folderId;
  }

  return patch;
}

/**
 * Wrap a compendium item for creation, stamping its sourceUuid provenance flag.
 */
export function buildTier1Item(item: CompendiumDocumentItem): Dnd5eItem {
  const wrapped = structuredClone(item) as Dnd5eItem;
  if (!wrapped.flags) {
    wrapped.flags = {};
  }
  if (!wrapped.flags["foundry-mcp-bridge"]) {
    wrapped.flags["foundry-mcp-bridge"] = {};
  }
  wrapped.flags["foundry-mcp-bridge"].sourceUuid = item.uuid;
  return wrapped;
}

/**
 * Strip item-level runtime fields (spent uses, equipped, attunement) for updates.
 * Preserves the item structure while removing GM-owned state.
 */
export function buildTier1ItemPatch(item: CompendiumDocumentItem): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  patch.name = item.name;
  patch.img = item.img;
  patch.system = structuredClone(item.system);

  // Strip runtime leaves from item.system
  const sys = patch.system as Record<string, any>;
  if (sys.uses) {
    delete sys.uses.spent;
  }
  delete sys.equipped;
  delete sys.attuned;

  return patch;
}

/**
 * Build a full Tier 1 actor document from compendium data, stamping
 * statblockKey, tier, and compendiumUuid flags. All items are wrapped
 * with sourceUuid provenance.
 */
export function buildTier1ActorData(
  fresh: CompendiumDocument,
  key: string,
  compendiumUuid: string,
  folderId?: string,
  resolvedImagePath?: string
): Dnd5eActorDocument {
  const actor: Dnd5eActorDocument = {
    name: fresh.name,
    type: "npc",
    system: structuredClone(fresh.system),
    items: fresh.items.map(item => buildTier1Item(item)),
    effects: [],
    flags: {
      "foundry-mcp-bridge": {
        statblockKey: key,
        tier: 1,
        compendiumUuid,
      },
    },
  };

  if (resolvedImagePath) {
    actor.img = resolvedImagePath;
  }

  if (folderId) {
    actor.folder = folderId;
  }

  return actor;
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
  deps: ImportNpcDeps,
  currentItems: Array<{ _id: string; flags?: Record<string, any> }> = []
): Promise<void> {
  // Skip spells already attached from a prior import (matched by their own
  // statblockKey flag) — re-searching and re-cloning a spell that's already
  // correctly attached would duplicate it on every re-import instead of
  // resolving only new/changed entries (see design doc's item-diff intent).
  // `currentItems` is the actor's full item list, already fetched by the
  // update path's diffAndApplyItems — passed in rather than re-fetched here
  // to avoid a second full-actor round trip on every upsert.
  const existingSpellItems = currentItems.filter((i) => {
    const key = i.flags?.["foundry-mcp-bridge"]?.statblockKey;
    return typeof key === "string" && key.startsWith("spell/");
  });
  const existingSpellKeys = new Set(
    existingSpellItems.map((i) => i.flags!["foundry-mcp-bridge"]!.statblockKey as string),
  );

  const freshSpellKeys = new Set<string>();
  for (const level of spellcasting.levels) {
    for (const spellName of level.spellNames) {
      const key = `spell/${statblockKey(spellName)}`;
      freshSpellKeys.add(key);
      // Also skip a duplicate spell name within this same statblock (checked
      // against keys already processed this call, not just ones from a prior
      // import) — existingSpellKeys alone only guards cross-run duplicates.
      if (existingSpellKeys.has(key)) continue;
      existingSpellKeys.add(key);

      const results = await deps.searchSpellCompendium(spellName);
      const exactIn = (pack: string) =>
        results.find(
          (r) => r.pack === pack && r.name.toLowerCase() === spellName.toLowerCase()
        );
      const match = exactIn("dnd5e.spells24") ?? exactIn("dnd5e.spells");

      if (match) {
        await deps.importEmbeddedFromCompendium(actorId, match.uuid, {
          flags: { "foundry-mcp-bridge": { statblockKey: key } },
        });
      } else {
        await deps.createEmbeddedItem(actorId, {
          name: spellName,
          type: "spell",
          img: "icons/svg/book.svg",
          flags: { "foundry-mcp-bridge": { statblockKey: key } },
        });
      }
    }
  }

  // Delete spells removed from the note on re-import — the design doc groups
  // spells with actions/feats under the same create/update/delete key-diff
  // contract; only re-resolving unchanged keys is skipped, not deletion.
  for (const item of existingSpellItems) {
    const key = item.flags!["foundry-mcp-bridge"]!.statblockKey as string;
    if (!freshSpellKeys.has(key)) {
      await deps.deleteEmbeddedItem(actorId, item._id);
    }
  }
}

/**
 * Diff tool-created items (those with statblockKey flags) on an actor against
 * a fresh statblock synthesis. Matched items are updated in-place (preserving _id),
 * new items are created, removed items are deleted, and GM-added unflagged items
 * are preserved.
 *
 * Returns a summary of changes plus the actor's full pre-diff item list, so the
 * caller (importNpc's update path) can hand it to attachSpells instead of
 * re-fetching the same actor a second time.
 */
async function diffAndApplyItems(
  actorId: string,
  statblock: StatblockData,
  deps: ImportNpcDeps
): Promise<{
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  currentItems: Array<{ _id: string; name: string; type: string; img?: string; system?: unknown; flags?: Record<string, any> }>;
}> {
  // Fetch current items
  const currentItems = await deps.findActorItems(actorId);

  // Synthesize fresh item list
  const freshActor = statblockToFoundryActor(statblock);
  const freshItems = freshActor.items;

  // Partition current items by flag presence. Unflagged (GM-added) items are
  // preserved implicitly: they're excluded from currentByKey below, so none
  // of the create/update/delete loops ever touch them. Spell items (flagged
  // "spell/...") are also excluded here even though they're tool-created:
  // they're synthesized and diffed separately by attachSpells, not by
  // statblockToFoundryActor's actor.items — treating them as "in scope" here
  // would make this loop delete them right before attachSpells re-adds them.
  const flaggedItems = currentItems.filter((i) => {
    const key = i.flags?.["foundry-mcp-bridge"]?.statblockKey;
    return typeof key === "string" && !key.startsWith("spell/");
  });

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

    // Compare only the fields we own (name/img/system), and only that our
    // own leaves are still present — not whole-object equality. A real
    // Foundry/dnd5e item is normalized on create/read with extra derived
    // fields our synthesis never populates (and never will), so isSubset
    // (actual ⊇ expected) is what "nothing meaningful changed" means here;
    // JSON.stringify equality reported every real item as "changed" on every
    // re-import even when the statblock was untouched.
    const changed =
      currentItem.name !== freshItem.name ||
      currentItem.img !== freshItem.img ||
      !isSubset(currentItem.system, freshItem.system);

    if (changed) {
      await deps.updateEmbeddedItem(actorId, currentItem._id, {
        name: freshItem.name,
        img: freshItem.img,
        system: freshItem.system,
      });
      updated++;
    } else {
      unchanged++;
    }
  }

  // Delete removed items (current key not in fresh, and flagged)
  for (const [currentKey, currentItem] of currentByKey) {
    if (!freshByKey.has(currentKey)) {
      await deps.deleteEmbeddedItem(actorId, currentItem._id);
      deleted++;
    }
  }

  return { created, updated, deleted, unchanged, currentItems };
}
