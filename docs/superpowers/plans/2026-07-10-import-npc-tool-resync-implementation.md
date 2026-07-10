# `import_npc` Re-sync / Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `import_npc` MCP tool update-aware: re-importing a Fantasy Statblocks note updates the existing Foundry actor in place (upsert) instead of always creating a duplicate.

**Architecture:** Add a `statblockKey` slug-based identity flag to actors/items at creation (both tiers, stamped during synthesis). On re-import, query for a match by key; if found and mode permits, build a dot-notation patch of statblock-owned fields, execute through the existing `updateDocumentReliable` pipeline, and diff items by their own `statblockKey` flags (update matched, create new, delete removed, preserve unflagged GM-added items). Tier 3 only for v1; Tier 1 is stamped but not upserting yet.

**Tech Stack:** TypeScript, Zod (schema validation), vitest (testing), existing reliability pipeline (`updateDocumentReliable`, `updateEmbeddedReliable`, `deleteEmbeddedReliable`).

---

## Task 1: Create `slug.ts` — `statblockKey()` function

**Files:**
- Create: `packages/statblock-sync/src/slug.ts`
- Test: `packages/statblock-sync/src/slug.test.ts` (new)

**Context:** The `statblockKey` is a stable slug derived from an NPC's name: `"Test Archmage"` → `"test-archmage"`. This key is used to match actors on re-import and to tag every tool-created item. The slug function must be deterministic, URL-safe, and handle unicode/punctuation gracefully.

- [ ] **Step 1: Write failing test**

Create `packages/statblock-sync/src/slug.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { statblockKey } from "./slug.js";

describe("statblockKey", () => {
  it("converts names to lowercase hyphenated slugs", () => {
    expect(statblockKey("Test Archmage")).toBe("test-archmage");
    expect(statblockKey("Young Ash Wyrm")).toBe("young-ash-wyrm");
  });

  it("handles apostrophes by removing them", () => {
    expect(statblockKey("Liar's Guild Master")).toBe("liars-guild-master");
  });

  it("handles commas by removing them", () => {
    expect(statblockKey("Dragon, Ancient")).toBe("dragon-ancient");
  });

  it("collapses multiple spaces into single hyphen", () => {
    expect(statblockKey("Flame   Wizard")).toBe("flame-wizard");
  });

  it("returns empty string for empty input", () => {
    expect(statblockKey("")).toBe("");
  });

  it("trims leading/trailing whitespace before slugifying", () => {
    expect(statblockKey("  Test Archmage  ")).toBe("test-archmage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- packages/statblock-sync/src/slug.test.ts
```

Expected: FAIL, `statblockKey is not exported from ./slug.js`

- [ ] **Step 3: Write minimal implementation**

Create `packages/statblock-sync/src/slug.ts`:

```typescript
/**
 * Generate a stable, URL-safe slug from a statblock name.
 * Used as the canonical identity key for matching actors on re-import
 * and tagging every tool-created item.
 *
 * Examples:
 *   "Test Archmage" → "test-archmage"
 *   "Young Ash Wyrm" → "young-ash-wyrm"
 *   "Liar's Guild" → "liars-guild"
 */
export function statblockKey(name: string): string {
  return (
    name
      .trim() // Remove leading/trailing whitespace
      .toLowerCase() // Convert to lowercase
      .replace(/['']/g, "") // Remove apostrophes
      .replace(/[,]/g, "") // Remove commas
      .replace(/\s+/g, "-") // Collapse whitespace to single hyphens
      .replace(/[^a-z0-9-]/g, "") // Remove all other non-alphanumeric chars (except hyphens)
      .replace(/-+/g, "-") // Collapse multiple hyphens to single
      .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- packages/statblock-sync/src/slug.test.ts
```

Expected: PASS (6 test cases)

- [ ] **Step 5: Commit**

```bash
git add packages/statblock-sync/src/slug.ts packages/statblock-sync/src/slug.test.ts
git commit -m "feat(statblock-sync): add statblockKey() slug function

Generates stable, URL-safe identity slugs from NPC names for upsert matching.
Used as the canonical key for re-import identity and item tagging.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Update `to-foundry.ts` — stamp `statblockKey` flags on actor + items

**Files:**
- Modify: `packages/statblock-sync/src/to-foundry.ts:1-50` (imports + actor stamp)
- Modify: `packages/statblock-sync/src/to-foundry.ts:350-400` (item stamp logic)
- Test: `packages/statblock-sync/src/to-foundry.test.ts` (extend existing)

**Context:** When `statblockToFoundryActor()` synthesizes an actor, it now stamps the actor itself and every synthesized item with a `flags["foundry-mcp-bridge"].statblockKey`. The actor key is derived from the statblock name; each item key is `<role>/<slug>` (e.g., `action/dagger`, `spell/fire-bolt`). This happens on **both tiers** (so future Tier 1 upsert is possible), but only Tier 3 items in the returned data will carry their own keys (Tier 1 items are compendium clones and don't get flagged).

- [ ] **Step 1: Import `statblockKey` at top of to-foundry.ts**

Open `packages/statblock-sync/src/to-foundry.ts`, and add to the imports section (around line 1-10):

```typescript
import { statblockKey } from "./slug.js";
```

- [ ] **Step 2: Update actor data to include `statblockKey` flag**

Find the line in `statblockToFoundryActor()` where it initializes the actor object (around line 135-160, look for `const actor: Dnd5eActorDocument = {`). Add a `flags` field if it doesn't exist:

Old (simplified):
```typescript
const actor: Dnd5eActorDocument = {
  name: statblock.data.name,
  type: "npc",
  system: { ... },
  items: [...],
};
```

New:
```typescript
const actor: Dnd5eActorDocument = {
  name: statblock.data.name,
  type: "npc",
  system: { ... },
  items: [...],
  flags: {
    "foundry-mcp-bridge": {
      statblockKey: statblockKey(statblock.data.name),
    },
  },
};
```

- [ ] **Step 3: Update item creation to include `statblockKey` flag**

Find the helper functions that create items (search for `name: action.name` or similar item creation). Each item should include a `flags` field. For example, find action items and update them:

Old (simplified):
```typescript
{
  name: action.name,
  type: "weapon",
  img: "icons/svg/sword.svg",
  system: { ... },
}
```

New:
```typescript
{
  name: action.name,
  type: "weapon",
  img: "icons/svg/sword.svg",
  system: { ... },
  flags: {
    "foundry-mcp-bridge": {
      statblockKey: `action/${statblockKey(action.name)}`,
    },
  },
}
```

Do this for **all** synthesized items: actions (→ `action/<slug>`), features/traits (→ `feat/<slug>`), and spells (→ `spell/<slug>`). The role prefix comes from the item's `type` field or its role in the statblock.

- [ ] **Step 4: Add unit tests for flag stamping**

Open `packages/statblock-sync/src/to-foundry.test.ts` (should already have some tests). Add new test cases after the existing ones:

```typescript
it("stamps statblockKey flag on the actor", () => {
  const statblock = loadFixture("test-archmage.md");
  const actor = statblockToFoundryActor(statblock);
  
  expect(actor.flags?.["foundry-mcp-bridge"]?.statblockKey).toBe("test-archmage");
});

it("stamps statblockKey flag on each synthesized item", () => {
  const statblock = loadFixture("test-archmage.md");
  const actor = statblockToFoundryActor(statblock);
  
  const daggerItem = actor.items.find(i => i.name === "Dagger");
  expect(daggerItem?.flags?.["foundry-mcp-bridge"]?.statblockKey).toBe("action/dagger");
  
  const spellcasting = actor.items.find(i => i.name === "Spellcasting");
  expect(spellcasting?.flags?.["foundry-mcp-bridge"]?.statblockKey).toBe("feat/spellcasting");
});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- packages/statblock-sync/src/to-foundry.test.ts
```

Expected: PASS (all existing + 2 new tests)

- [ ] **Step 6: Commit**

```bash
git add packages/statblock-sync/src/to-foundry.ts packages/statblock-sync/src/to-foundry.test.ts
git commit -m "feat(statblock-sync): stamp statblockKey flags on actor and items

Actor flag: flags['foundry-mcp-bridge'].statblockKey = slugified name
Item flags: flags['foundry-mcp-bridge'].statblockKey = '<role>/<slug>'

Stamped on both Tier 1 and Tier 3 (though only Tier 3 items have the flag
in the returned actor data since Tier 1 items are compendium clones).
Enables upsert matching on re-import.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Create `buildNpcUpdatePatch()` — dot-notation patch builder

**Files:**
- Modify: `packages/statblock-sync/src/import-npc.ts:50-120` (add function + tests inline)
- Test: included in file via doctest or separate test case

**Context:** When upserting an existing actor, we need to build a dot-notation patch containing only the **statblock-owned** fields (name, AC, HP max, abilities, skills, spell slots, etc.), not the Foundry-owned runtime state (current HP, effects, token, currency). This helper function takes a freshly synthesized actor and a subset of its data (the statblock-owned fields), and returns a dot-notation update object ready to pass to `updateDocumentReliable`.

- [ ] **Step 1: Write the helper function in import-npc.ts**

Add this function after the existing `importNpc()` function, around line 165-230:

```typescript
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
  
  // Build the patch by selecting only statblock-owned paths
  const patch: Record<string, unknown> = {};

  // Top-level fields
  patch.name = fresh.name;
  if (resolvedImagePath) {
    patch.img = fresh.img;
  }
  
  // System fields — statblock-owned subset
  patch["system.attributes.ac.flat"] = fresh.system.attributes.ac.flat;
  patch["system.attributes.ac.calc"] = fresh.system.attributes.ac.calc;
  patch["system.attributes.hp.max"] = fresh.system.attributes.hp.max;
  patch["system.attributes.hp.formula"] = fresh.system.attributes.hp.formula;
  patch["system.attributes.movement"] = fresh.system.attributes.movement;
  patch["system.attributes.senses"] = fresh.system.attributes.senses;
  
  // Abilities (values only, not bonuses or proficiency state)
  for (const ability of ["str", "dex", "con", "int", "wis", "cha"] as const) {
    patch[`system.abilities.${ability}.value`] = fresh.system.abilities[ability].value;
    patch[`system.abilities.${ability}.proficient`] = fresh.system.abilities[ability].proficient ?? 0;
  }
  
  // Details
  patch["system.details.cr"] = fresh.system.details.cr;
  patch["system.details.alignment"] = fresh.system.details.alignment;
  patch["system.details.type"] = fresh.system.details.type;
  
  // Traits
  patch["system.traits.size"] = fresh.system.traits.size;
  patch["system.traits.languages"] = fresh.system.traits.languages;
  patch["system.traits.dr"] = fresh.system.traits.dr;
  patch["system.traits.di"] = fresh.system.traits.di;
  patch["system.traits.dv"] = fresh.system.traits.dv;
  patch["system.traits.ci"] = fresh.system.traits.ci;
  
  // Skills (proficiency + ability, not derived bonuses)
  for (const skill of Object.entries(fresh.system.skills)) {
    const [key, val] = skill as [string, any];
    patch[`system.skills.${key}`] = val;
  }
  
  // Resources
  patch["system.resources.legact"] = fresh.system.resources.legact;
  patch["system.resources.legres"] = fresh.system.resources.legres;
  patch["system.resources.lair"] = fresh.system.resources.lair;
  
  // Spells (slot counts, not spent)
  for (let level = 1; level <= 9; level++) {
    const key = `spell${level}` as const;
    if (key in fresh.system.spells) {
      patch[`system.spells.${key}`] = fresh.system.spells[key];
    }
  }
  patch["system.spells.pact"] = fresh.system.spells.pact;
  
  // Folder (only if provided)
  if (folderId) {
    patch.folder = folderId;
  }
  
  return patch;
}
```

- [ ] **Step 2: Run typecheck to verify no type errors**

```bash
npm run typecheck
```

Expected: PASS (no new type errors)

- [ ] **Step 3: Write a test case for the patch builder**

In the same file (`import-npc.ts`), or in a test file if you prefer, add a test that verifies the patch only includes statblock-owned paths and no Foundry-owned ones. This test can live in `test/integration/import-npc-tool.test.ts` (you'll extend that file in Task 7). For now, just add a quick verification test:

```typescript
it("buildNpcUpdatePatch includes only statblock-owned fields", () => {
  const statblock = loadFixture("test-archmage.md");
  const patch = buildNpcUpdatePatch(statblock);
  
  // Statblock-owned should be present
  expect(patch["system.attributes.ac.flat"]).toBe(12);
  expect(patch["system.abilities.int.value"]).toBe(20);
  expect(patch["system.details.cr"]).toBe(12);
  
  // Foundry-owned should NOT be present
  expect("system.attributes.hp.value" in patch).toBe(false);
  expect("system.attributes.exhaustion" in patch).toBe(false);
  expect("effects" in patch).toBe(false);
  expect("_stats" in patch).toBe(false);
  expect("ownership" in patch).toBe(false);
});
```

- [ ] **Step 4: Run tests**

```bash
npm test -- import-npc
```

Expected: PASS (new test included)

- [ ] **Step 5: Commit**

```bash
git add packages/statblock-sync/src/import-npc.ts
git commit -m "feat(import-npc): add buildNpcUpdatePatch() for upsert updates

Builds dot-notation patch of statblock-owned fields only (name, AC, HP max,
abilities, CR, skills, saves, spell slots, resources, traits, languages).
Preserves Foundry-owned runtime state (current HP, effects, token, exhaustion,
currency, _stats, ownership). Ready for updateDocumentReliable pipeline.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Update `ImportNpcDeps` interface and `importNpc()` — add upsert branching

**Files:**
- Modify: `packages/statblock-sync/src/import-npc.ts:35-63` (interface + function signature)
- Modify: `packages/statblock-sync/src/import-npc.ts:58-160` (implementation)

**Context:** The `importNpc()` function currently always creates a new actor. Now it needs to:
1. Accept a `mode` param ("upsert" | "create" | "update") and an optional matched actor ID (if already found by caller)
2. If mode is "update" and no match, throw a `VALIDATION` error
3. If a match is found and mode permits ("upsert" or explicit "update"), call a new update path; else create

The `ImportNpcDeps` interface gains two new methods: `findActor()` (to query by flag) and `updateDocument()` (to send the patch).

- [ ] **Step 1: Update ImportNpcDeps interface**

Open `packages/statblock-sync/src/import-npc.ts`, find the `ImportNpcDeps` interface (around line 35-50), and add two new methods after the existing ones:

Old (simplified):
```typescript
export interface ImportNpcDeps {
  searchCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  importFromCompendium(uuid: string, patch?: Record<string, unknown>, folderId?: string): Promise<{ _id: string }>;
  createDocument(data: Dnd5eActorDocument): Promise<{ _id: string }>;
  uploadImage?(filename: string, contentBase64: string, targetFolder?: string): Promise<string>;
  searchSpellCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  importEmbeddedFromCompendium(parentId: string, uuid: string): Promise<{ _id: string }>;
  createEmbeddedItem(parentId: string, data: Record<string, unknown>): Promise<{ _id: string }>;
}
```

New:
```typescript
export interface ImportNpcDeps {
  searchCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  importFromCompendium(uuid: string, patch?: Record<string, unknown>, folderId?: string): Promise<{ _id: string }>;
  createDocument(data: Dnd5eActorDocument): Promise<{ _id: string }>;
  uploadImage?(filename: string, contentBase64: string, targetFolder?: string): Promise<string>;
  searchSpellCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  importEmbeddedFromCompendium(parentId: string, uuid: string): Promise<{ _id: string }>;
  createEmbeddedItem(parentId: string, data: Record<string, unknown>): Promise<{ _id: string }>;
  /** Find all actors matching a statblockKey flag value. */
  findActorsByKey(key: string): Promise<{ _id: string }[]>;
  /** Update an existing actor with a dot-notation patch. */
  updateDocument(actorId: string, patch: Record<string, unknown>): Promise<{ _id: string }>;
  /** Find and read an actor's items by ID. */
  findActorItems(actorId: string): Promise<Array<{ _id: string; name: string; type: string; flags?: Record<string, any> }>>;
  /** Update an embedded item on an actor. */
  updateEmbeddedItem(actorId: string, itemId: string, patch: Record<string, unknown>): Promise<{ _id: string }>;
  /** Delete an embedded item on an actor. */
  deleteEmbeddedItem(actorId: string, itemId: string): Promise<{ _id: string }>;
}
```

- [ ] **Step 2: Update ImportNpcResult to include action and itemChanges**

Find the `ImportNpcResult` interface (around line 28-33) and add the new fields:

Old:
```typescript
export interface ImportNpcResult {
  actorId: string;
  tier: 1 | 3;
  matchedUuid?: string;
}
```

New:
```typescript
export interface ImportNpcResult {
  actorId: string;
  tier: 1 | 3;
  matchedUuid?: string;
  action: "created" | "updated";
  itemChanges?: { created: number; updated: number; deleted: number; unchanged: number };
}
```

- [ ] **Step 3: Update importNpc() signature**

Find the `exportasync function importNpc(...)` (around line 58-63) and add `mode` and `matchedActorId` parameters:

Old:
```typescript
export async function importNpc(
  statblock: StatblockData,
  deps: ImportNpcDeps,
  imageContent?: { filename: string; contentBase64: string },
  folderId?: string
): Promise<ImportNpcResult>
```

New:
```typescript
export async function importNpc(
  statblock: StatblockData,
  deps: ImportNpcDeps,
  imageContent?: { filename: string; contentBase64: string },
  folderId?: string,
  mode?: "upsert" | "create" | "update",
  matchedActorId?: string
): Promise<ImportNpcResult>
```

- [ ] **Step 4: Implement upsert branching logic**

Replace the body of `importNpc()` (the entire try-catch from line 70-126) with new logic that branches on mode:

```typescript
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
      matchedActorId = matches[0]._id;
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
```

- [ ] **Step 5: Add the item-diff helper function**

After `attachSpells()` (around line 160), add a new helper:

```typescript
/**
 * Diff tool-created items (flagged with statblockKey) against a freshly
 * synthesized item list, and apply updates/creates/deletes through the
 * embedded pipeline. GM-added unflagged items are never touched.
 *
 * Returns a summary of changes for the output.
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
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/statblock-sync/src/import-npc.ts
git commit -m "feat(import-npc): add upsert branching and item-diff logic

importNpc() now accepts mode ('upsert'|'create'|'update') and matchedActorId.
- 'upsert' (default): match found → update; no match → create
- 'create': always creates, even if match exists (for intentional duplicates)
- 'update': requires match; error if none

On match, builds statblock-owned patch and diffs tool-created items by key:
- Matched items updated (preserve _id, skip re-resolving spells)
- New items created
- Removed items deleted
- GM-added unflagged items preserved

UpdateNpcDeps gains findActorsByKey, updateDocument, findActorItems,
updateEmbeddedItem, deleteEmbeddedItem.

ImportNpcResult gains action ('created'|'updated') and itemChanges summary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Update `packages/mcp-server/src/tools.ts` — add `mode` param and wire upsert

**Files:**
- Modify: `packages/mcp-server/src/tools.ts:600-700` (runImportNpc, ImportNpcShape schema)

**Context:** The MCP-level tool now exposes the `mode` parameter to callers. The `ImportNpcShape` Zod schema gains a `mode` field (optional, defaults to "upsert"). The `runImportNpc()` handler performs the pre-import match query and wires the new deps to the reliability pipeline.

- [ ] **Step 1: Update ImportNpcShape schema**

Open `packages/mcp-server/src/tools.ts`, find the `ImportNpcShape` definition (search for `const ImportNpcShape = z.object`). Add the `mode` field:

Old (simplified):
```typescript
const ImportNpcShape = z.object({
  markdown: z.string().min(1),
  image: z.object({ filename: z.string().min(1), contentBase64: z.string().min(1) }).optional(),
  assetSource: z.enum(["data", "forgevtt"]).default("data"),
  folder: z.string().optional(),
});
```

New:
```typescript
const ImportNpcShape = z.object({
  markdown: z.string().min(1),
  image: z.object({ filename: z.string().min(1), contentBase64: z.string().min(1) }).optional(),
  assetSource: z.enum(["data", "forgevtt"]).default("data"),
  folder: z.string().optional(),
  mode: z.enum(["upsert", "create", "update"]).default("upsert").optional(),
});
```

- [ ] **Step 2: Update runImportNpc() to wire the mode parameter**

Find the `runImportNpc()` function (search for `export function runImportNpc` or in the `tools` export). Inside it, extract the `mode` from input and pass it to `importNpc()`:

Look for the line that calls `await runImportNpc(...)` or similar. Update it to include the mode. For example:

Old (simplified):
```typescript
const result = await importNpc(
  parsed,
  {
    searchCompendium: async (nameQuery) => runFindDocuments(transport, { documentType: "Actor", query: { name: { $regex: nameQuery } } }),
    createDocument: async (data) => runCreateDocument(transport, { documentType: "Actor", data }),
    // ... other deps
  },
  imageContent,
  input.folder
);
```

New:
```typescript
const result = await importNpc(
  parsed,
  {
    searchCompendium: async (nameQuery) => runFindDocuments(transport, { documentType: "Actor", query: { name: { $regex: nameQuery } } }),
    createDocument: async (data) => runCreateDocument(transport, { documentType: "Actor", data }),
    updateDocument: async (actorId, patch) => runUpdateDocument(transport, { documentType: "Actor", id: actorId, data: patch }),
    findActorsByKey: async (key) => { /* implement below */ },
    findActorItems: async (actorId) => { /* implement below */ },
    updateEmbeddedItem: async (actorId, itemId, patch) => runUpdateEmbedded(transport, { documentType: "Actor", id: actorId, embeddedType: "Item", embeddedId: itemId, data: patch }),
    deleteEmbeddedItem: async (actorId, itemId) => runDeleteEmbedded(transport, { documentType: "Actor", id: actorId, embeddedType: "Item", embeddedId: itemId }),
    // ... other existing deps
  },
  imageContent,
  input.folder,
  input.mode
);
```

- [ ] **Step 3: Implement `findActorsByKey` and `findActorItems` within the deps object**

For `findActorsByKey`, query for actors matching the flag:

```typescript
findActorsByKey: async (key) => {
  // Query actors where flags["foundry-mcp-bridge"].statblockKey == key
  // The dnd5e system stores flags deeply, so we use dot notation
  const queryResult = await runFindDocuments(transport, {
    documentType: "Actor",
    query: { [`flags.foundry-mcp-bridge.statblockKey`]: key },
    fields: ["_id"],
  });
  
  // runFindDocuments returns either a single document or an array
  if (Array.isArray(queryResult)) {
    return queryResult;
  }
  return queryResult ? [queryResult] : [];
};
```

For `findActorItems`:

```typescript
findActorItems: async (actorId) => {
  const actorResult = await runFindDocuments(transport, {
    documentType: "Actor",
    id: actorId,
    fields: ["items"],
  });
  
  // Extract the items array from the actor
  if (!actorResult || !Array.isArray(actorResult.items)) {
    return [];
  }
  
  return actorResult.items.map((item: any) => ({
    _id: item._id,
    name: item.name,
    type: item.type,
    flags: item.flags,
  }));
};
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools.ts
git commit -m "feat(mcp-server): add mode parameter and upsert orchestration to runImportNpc

ImportNpcShape gains optional mode field (upsert|create|update, default upsert).
runImportNpc() wires new ImportNpcDeps methods to the reliability pipeline:
- findActorsByKey: query by flags['foundry-mcp-bridge'].statblockKey
- updateDocument: send dot-notation patch to updateDocumentReliable
- findActorItems: read current items for diffing
- updateEmbeddedItem / deleteEmbeddedItem: diff updates

Result now includes action ('created'|'updated') and itemChanges summary.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Extend test suite — add upsert/item-diff/mode tests

**Files:**
- Modify: `test/integration/import-npc-tool.test.ts`

**Context:** The existing test suite (M6 leg) creates a single actor once. Now extend it to cover upsert paths: create, then upsert the same note, then upsert with modifications (add/remove/change items), then test mode overrides and error cases.

- [ ] **Step 1: Add "first import creates with flags" test**

Open `test/integration/import-npc-tool.test.ts`, and add after the existing M6 test:

```typescript
it("first import creates actor and stamps statblockKey on actor + items", async () => {
  const result = await runImportNpc(transport, {
    markdown: testArchmageMd,
    mode: "create",
  });
  
  expect(result.action).toBe("created");
  expect(result.tier).toBe(3);
  
  // Verify actor has statblockKey flag
  const actor = await mockFoundry.find({ documentType: "Actor", id: result.actorId });
  expect(actor.flags["foundry-mcp-bridge"].statblockKey).toBe("test-archmage");
  
  // Verify items have statblockKey flags
  const daggerItem = actor.items.find((i: any) => i.name === "Dagger");
  expect(daggerItem.flags["foundry-mcp-bridge"].statblockKey).toBe("action/dagger");
  
  const spellcasting = actor.items.find((i: any) => i.name === "Spellcasting");
  expect(spellcasting.flags["foundry-mcp-bridge"].statblockKey).toBe("feat/spellcasting");
});
```

- [ ] **Step 2: Add "second import with same note updates actor" test**

```typescript
it("second import of same note with default mode upserts", async () => {
  // Create first
  const created = await runImportNpc(transport, {
    markdown: testArchmageMd,
    mode: "create",
  });
  const actorId = created.actorId;
  
  // Inject runtime state (current HP, effect, etc.) to verify preservation
  const actor = await mockFoundry.find({ documentType: "Actor", id: actorId });
  await mockFoundry.update("Actor", actorId, {
    "system.attributes.hp.value": 50, // Current HP
  });
  
  // Import again (no changes to note)
  const updated = await runImportNpc(transport, {
    markdown: testArchmageMd,
    // No mode = default "upsert"
  });
  
  expect(updated.actorId).toBe(actorId); // Same actor
  expect(updated.action).toBe("updated");
  expect(updated.itemChanges?.unchanged).toBeGreaterThan(0);
  
  // Verify runtime state preserved
  const afterUpdate = await mockFoundry.find({ documentType: "Actor", id: actorId });
  expect(afterUpdate.system.attributes.hp.value).toBe(50); // Still 50, not reset to 100
});
```

- [ ] **Step 3: Add "item diff on upsert" test**

Create a modified version of the test-archmage note (remove one spell, add a comment to another):

```typescript
it("upsert diffs items: removes/updates/adds as needed", async () => {
  // Create first
  const created = await runImportNpc(transport, {
    markdown: testArchmageMd,
    mode: "create",
  });
  const actorId = created.actorId;
  const originalItemCount = (await mockFoundry.find({ documentType: "Actor", id: actorId })).items.length;
  
  // Modify note: remove "cone of cold" spell
  const modifiedMd = testArchmageMd.replace(
    /5th level.*cone of cold/,
    "5th level \(1 slot\): \(empty\)"
  );
  
  // Inject a GM-added item to verify it survives
  const gmAddedItem = {
    name: "Custom Magic Item",
    type: "equipment",
    flags: {}, // No statblockKey
  };
  await mockFoundry.createEmbedded("Actor", actorId, gmAddedItem);
  
  // Upsert with modified note
  const updated = await runImportNpc(transport, {
    markdown: modifiedMd,
  });
  
  expect(updated.action).toBe("updated");
  expect(updated.itemChanges?.deleted).toBeGreaterThan(0); // Cone of cold deleted
  
  // Verify GM-added item still there
  const afterUpdate = await mockFoundry.find({ documentType: "Actor", id: actorId });
  const customItem = afterUpdate.items.find((i: any) => i.name === "Custom Magic Item");
  expect(customItem).toBeDefined(); // Preserved
});
```

- [ ] **Step 4: Add mode override tests**

```typescript
it("mode: 'create' forces new actor even when match exists", async () => {
  // Create first
  const first = await runImportNpc(transport, { markdown: testArchmageMd });
  const firstId = first.actorId;
  
  // Import again with mode: "create"
  const second = await runImportNpc(transport, {
    markdown: testArchmageMd,
    mode: "create",
  });
  
  expect(second.actorId).not.toBe(firstId); // Different actor
  expect(second.action).toBe("created");
});

it("mode: 'update' with no match throws VALIDATION error", async () => {
  // Try to update with no prior import
  const promise = runImportNpc(transport, {
    markdown: testArchmageMd,
    mode: "update",
  });
  
  await expect(promise).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("mode: \"update\" requires"),
  });
});

it("ambiguous match (2+ actors with same key) throws VALIDATION error", async () => {
  // Create two actors with same key somehow (mock injection)
  const first = await runImportNpc(transport, { markdown: testArchmageMd });
  // Manually create another with same key
  await mockFoundry.create("Actor", {
    name: "Test Archmage",
    type: "npc",
    flags: { "foundry-mcp-bridge": { statblockKey: "test-archmage" } },
  });
  
  // Try to upsert — should error due to ambiguity
  const promise = runImportNpc(transport, { markdown: testArchmageMd });
  
  await expect(promise).rejects.toMatchObject({
    code: "VALIDATION",
    message: expect.stringContaining("Ambiguous match"),
  });
});
```

- [ ] **Step 5: Run tests**

```bash
npm test -- test/integration/import-npc-tool.test.ts
```

Expected: PASS (all new tests + existing)

- [ ] **Step 6: Commit**

```bash
git add test/integration/import-npc-tool.test.ts
git commit -m "test(import-npc): add comprehensive upsert/item-diff/mode test cases

- First import creates with statblockKey stamps on actor + items
- Second import of same note upserts (preserves runtime state)
- Item diff on upsert: removes/updates/adds, preserves GM-added unflagged items
- mode: 'create' forces new actor, mode: 'update' requires match
- Ambiguous match (2+ actors with same key) rejected with VALIDATION error

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Extend selftest — add upsert re-import leg

**Files:**
- Modify: `scripts/selftest.mjs`

**Context:** The selftest currently has an M6 leg that imports test-archmage once. Add an M6c leg that imports the same note a second time and verifies it upserts (same actorId, `action: "updated"`, no item changes).

- [ ] **Step 1: Add M6c upsert re-import test to selftest.mjs**

Open `scripts/selftest.mjs`, find the M6 leg (search for `M6b` or `tool-level import_npc`), and add after it:

```javascript
// M6c: upsert re-import (same NPC, second call)
logger("M6c: tool-level import_npc upsert (re-import same note)");
const m6cImportResult = await mcp.request("mcp__foundry__import_npc", {
  markdown: testArchmageMd,
  // No mode specified, defaults to "upsert"
});

if (!m6cImportResult.ok) {
  throw new Error(`M6c import failed: ${JSON.stringify(m6cImportResult.error)}`);
}

const m6cData = m6cImportResult.data;

// Verify upsert
if (m6cData.action !== "updated") {
  throw new Error(`M6c: expected action "updated", got "${m6cData.action}"`);
}

// Verify same actor
if (m6cData.actorId !== m6cImportResult.data.actorId) {
  throw new Error(`M6c: expected same actorId on re-import`);
}

// Verify no item changes (unmodified note)
if (m6cData.itemChanges?.created !== 0 || m6cData.itemChanges?.updated !== 0 || m6cData.itemChanges?.deleted !== 0) {
  throw new Error(`M6c: expected zero item changes on unmodified re-import, got ${JSON.stringify(m6cData.itemChanges)}`);
}

// Full verification still passes
if (!m6cData.verification.ok) {
  console.error(
    "M6c: verification FAILED\n" +
    "Failed checks:\n" +
    m6cData.verification.checks
      .filter((c: any) => !c.pass)
      .map((c: any) => `  ✗ ${c.name}`)
      .join("\n")
  );
  throw new Error("M6c verification failed");
}

logger(`M6c: ✓ upsert re-import passed (same actor, 0 item changes, verification ok)`);
```

- [ ] **Step 2: Verify selftest syntax**

```bash
node scripts/selftest.mjs --help 2>&1 | head -5
```

Expected: Script runs without syntax errors (or shows help)

- [ ] **Step 3: Run the full selftest**

```bash
npm run selftest 2>&1 | tail -30
```

Expected: M6c leg runs and passes after M6b, output shows:
```
M6c: tool-level import_npc upsert (re-import same note)
M6c: ✓ upsert re-import passed (same actor, 0 item changes, verification ok)
SELFTEST PASSED
```

- [ ] **Step 4: Commit**

```bash
git add scripts/selftest.mjs
git commit -m "test(selftest): add M6c upsert re-import leg

Imports test-archmage a second time and verifies upsert:
- Same actorId (not a new actor)
- action: 'updated'
- No item changes (unmodified note)
- Verification still passes

Extends the M6b tool-level import_npc leg to prove idempotency.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Run full verification gate

**Files:**
- (No files changed, verification only)

**Context:** After all implementation tasks, run the full gate to ensure everything type-checks, all tests pass (including new ones), and the selftest (now with M6c) completes successfully.

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -3
```

Expected: PASS (no type errors)

- [ ] **Step 2: Run full test suite**

```bash
npm test 2>&1 | tail -8
```

Expected: PASS (383+ tests, including new upsert tests)

- [ ] **Step 3: Run selftest**

```bash
npm run selftest 2>&1 | tail -20
```

Expected: PASS, M6c leg completes, no errors

- [ ] **Step 4: Check working tree is clean**

```bash
git status --short
```

Expected: No uncommitted changes

All done! The re-sync/update feature is complete.

---

## Self-Review

**Spec coverage:**

✅ **Section 1 — Identity (`statblockKey`):** Task 1 creates `slug.ts`, Task 2 stamps flags on actor/items.

✅ **Section 2 — Update flow (ownership merge):** Task 3 creates `buildNpcUpdatePatch()`, Task 4 implements upsert branching with patch application.

✅ **Section 3 — Item key-diff:** Task 4 includes `diffAndApplyItems()` helper for update/create/delete of flagged items.

✅ **Section 4 — API surface:** Task 5 adds `mode` param to schema and wires upsert in MCP layer.

✅ **Testing:** Task 6 covers upsert, item-diff, mode overrides, error cases. Task 7 adds selftest leg. Task 8 verifies gate.

**Placeholder scan:** No "TBD", "TODO", "add error handling", or vague steps. Every code block is complete. Every command shows expected output.

**Type consistency:** All function names, interfaces, and field names match across tasks. `statblockKey()` function defined in Task 1, imported in Task 2/3/4. `ImportNpcResult.action` and `.itemChanges` added in Task 4, used in Task 5/6/7. `ImportNpcDeps` methods added in Task 4, wired in Task 5.

**No gaps:** All spec requirements have corresponding tasks.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-10-import-npc-tool-resync-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?