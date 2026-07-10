# Design: `import_npc` re-sync / update semantics

**Date:** 2026-07-10
**Status:** Approved (brainstorming), pending implementation plan

## Goal

Make the `import_npc` MCP tool **update-aware**: re-importing a Fantasy
Statblocks note that was already imported updates the existing Foundry actor
in place instead of always creating a duplicate. This is the "Phase 4"
sync-integration idea from `docs/obsidian-statblock-npc-sync-plan.md`, scoped
down to just the tool becoming upsert-capable — no note-side front-matter,
hashing, or planner integration (that remains the larger campaign-sync
follow-up, out of scope here).

## Non-goals

- **No Tier 1 (compendium-clone) re-sync in v1.** Tier 1 actors' items are
  official compendium items with no `statblockKey` of their own; upserting
  them needs a different strategy (re-clone-and-remerge or similar) that's a
  documented follow-up. v1 still **stamps** `statblockKey` on Tier 1 actors at
  creation so that follow-up has something to match against later — it just
  doesn't act on it yet. If a re-import's match plan resolves to Tier 1 but a
  Tier 3 actor with the same key already exists, the existing Tier 3 actor is
  upserted (matching wins over re-planning the tier).
- **No note-side identity (front-matter `foundryId`, content hashing, or
  planner "unchanged/push/pull" states).** Those belong to the full
  campaign-sync-style Phase 4 in the sync-plan doc. This feature only makes
  the *tool call* idempotent by name; the caller (human, or a future sync
  layer) still decides when to call it again.
- **No conflict detection beyond the existing read-back/rollback guarantee.**
  If a GM is mid-edit when an upsert lands, the usual dry-run → write →
  read-back → rollback contract is the only safety net; no additional
  locking or "remote changed" detection.
- **No cross-note collision resolution.** Two different notes sharing an NPC
  name produce the same `statblockKey` and will sync onto each other. This is
  a known v1 limitation (documented below), not silently handled.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| How is "the same NPC" identified on re-import? | **Provenance flag** — stamp `flags["foundry-mcp-bridge"].statblockKey` on the actor at creation; re-import matches by that flag. |
| What gets overwritten on a matched update? | **Ownership merge** — overwrite only the statblock-owned canonical subset; preserve Foundry-owned runtime state (current HP, effects, token, currency, `_stats`). |
| How are items (actions/features/spells) reconciled? | **Key-diff, tool-owned only** — each tool-created item carries its own `statblockKey`; re-import diffs the flagged subset (update matched / create new / delete removed), and never touches unflagged (GM-added) items. |
| When does update happen vs. create? | **Auto-upsert by default**, with an explicit `mode` param (`"upsert"` \| `"create"` \| `"update"`) to force either behavior. |
| Does this cover Tier 1 clones too? | **Tier 3 only for v1** (see Non-goals). Tier 1 actors are stamped but not upsert-targets yet. |

## Architecture

### 1. Identity: `statblockKey`

A stable slug derived from the statblock's `name` (lowercase, spaces →
hyphens, non-alphanumerics stripped — e.g. `"Test Archmage"` →
`test-archmage`). New helper in `packages/statblock-sync/src/`:

```ts
// slug.ts (new)
export function statblockKey(name: string): string
```

Stamped at creation on **both** tiers, under a namespaced flag:

- **Actor:** `flags["foundry-mcp-bridge"].statblockKey = statblockKey(name)`
- **Items** (Tier 3 only, since Tier 1 items are compendium clones):
  `flags["foundry-mcp-bridge"].statblockKey = "<role>/<slug>"`, where role is
  `action` | `feat` | `spell` and slug is the item's own name-derived slug
  (e.g. `action/dagger`, `feat/spellcasting`, `spell/fire-bolt`).

Matching, on every `import_npc` call (mode permitting):

```
find Actor where flags."foundry-mcp-bridge".statblockKey == statblockKey(name)
  0 matches → create path
  1 match   → upsert path
  2+ matches → VALIDATION error, details.matchedActorIds: string[]
```

**Known v1 limitation:** two notes with the same NPC name collide on the same
key. Acceptable because NPC names are expected to be unique within a
world/campaign; an explicit `syncKey` override param is a documented,
un-implemented follow-up if this becomes a real problem.

### 2. Update flow: ownership merge

On a matched upsert, build a **dot-notation patch** containing only
statblock-owned paths, and send it through the existing
`updateDocumentReliable` pipeline (dry-run → write → read-back verify →
rollback on mismatch — unchanged guarantee).

**Statblock-owned (overwritten):**
- `name`, `img` (only if a new `image` was supplied this call)
- `system.attributes.ac`, `system.attributes.hp.max`, `system.attributes.hp.formula`
- `system.attributes.movement`, `system.attributes.senses`
- `system.abilities.*.value`, `system.abilities.*.proficient` (saves)
- `system.details.cr`, `system.details.alignment`, `system.details.type`
- `system.traits.*` (size, languages, dr/di/dv/ci)
- `system.skills.*`
- `system.resources.legact`, `.legres`, `.lair`
- `system.spells.spell1`–`spell9`, `.pact` (`.value`/`.override`, not `.spent`)
- `folder` (only if `input.folder` given this call; omitted → untouched)

**Foundry-owned (never touched):**
- `system.attributes.hp.value`, `.temp`, `.tempmax`, `system.attributes.exhaustion`
- `effects`, `prototypeToken`, `system.currency`
- `ownership`, `_stats`, `flags` (except our own `statblockKey`, preserved as-is)

Implementation: a new `buildNpcUpdatePatch(statblock, resolvedImagePath?, folderId?)`
in `packages/statblock-sync/src/import-npc.ts` (or a sibling module) produces
this dot-notation object by re-using the same derivation logic
`statblockToFoundryActor` already has, filtered to the statblock-owned path
list above. `filterUnsafePaths`/`applyUpdate` from `packages/shared/src/objects.ts`
are reused for the dot-notation mechanics — no new merge engine.

### 3. Item key-diff

On upsert, read the matched actor's current items
(`find Actor { id, fields: ["items"] }`), partition into flagged
(`flags."foundry-mcp-bridge".statblockKey` present) vs. unflagged, then diff
**only the flagged set** against the freshly synthesized item list from
`statblockToFoundryActor`, matched by `statblockKey`:

| Case | Action |
|------|--------|
| Key in both existing (flagged) and new | `updateEmbeddedReliable` — patch `system`, `img`, `name`; item `_id` preserved |
| Key only in new | `createEmbeddedReliable` (+ stamp `statblockKey` flag) |
| Key only in existing flagged set | `deleteEmbeddedReliable` |
| No flag at all (GM-added) | untouched, always |

Runs as one batch per call: compute the three lists, execute each list's
operations through the existing embedded reliability pipeline, then read back
the full item list for `verifyImportedNpc`. Spell resolution for **unchanged**
spell keys is skipped (no need to re-search the compendium for a spell that's
already correctly attached) — only new/changed spell entries in the note
trigger `searchSpellCompendium`/`importEmbeddedFromCompendium`.

**Partial-failure contract stays consistent** with the existing
`attachSpells` case: if a mid-diff embedded op throws, the error carries
`{actorId, stage: "itemDiff", cause}`. Already-applied item changes and the
actor itself are **not** rolled back (a half-applied diff is still better data
than none — same philosophy as today's spell-attach partial failure).

### 4. API surface

**Input** (`ImportNpcShape` gains one field):
```ts
{
  markdown: string;
  image?: { filename: string; contentBase64: string };
  assetSource?: "data" | "forgevtt";
  folder?: string;
  mode?: "upsert" | "create" | "update";   // default: "upsert"
}
```
- `"upsert"` (default): match found → update; no match → create.
- `"create"`: always creates a new actor (today's shipped behavior), even if
  a match exists. Still stamps `statblockKey` (so a later upsert can match
  it). Use for an intentional duplicate.
- `"update"`: requires a match; `VALIDATION` error (details: `{statblockKey}`)
  if none exists. Guards against an accidental create when the caller
  expected an existing actor.

**Output** gains a discriminator and, on update, a change summary:
```ts
{
  actorId: string;
  tier: 1 | 3;
  matchedUuid?: string;
  action: "created" | "updated";                                       // NEW
  itemChanges?: { created: number; updated: number; deleted: number; unchanged: number }; // NEW, "updated" only
  verification: { ok: boolean; checks: [...] };
}
```

**New error cases:**
- Ambiguous match (2+ actors, same `statblockKey`) → `VALIDATION`,
  `details.matchedActorIds: string[]`.
- `mode: "update"` with zero matches → `VALIDATION`, `details.statblockKey`.

## Testing

**Unit — `statblockKey()`:** name → slug (spaces, punctuation, case).

**Unit — patch builder:** given a statblock, the dot-notation patch contains
exactly the statblock-owned paths and none of the Foundry-owned ones.

**Integration — `runImportNpc()` against MockFoundry** (extends
`test/integration/import-npc-tool.test.ts`):
- **First import stamps key, creates.** `action: "created"`, actor and items
  carry `statblockKey` flags.
- **Second import with same note, default mode → upsert.** `action:
  "updated"`, same `actorId`, statblock-owned fields refreshed,
  Foundry-owned fields (HP current value, injected effect, token name)
  preserved across the call.
- **Item diff — add/remove/modify.** Re-import a modified note (one action
  removed, one added, one damage value changed) → `itemChanges` reflects
  exactly `{created:1, updated:1, deleted:1, unchanged:N}`; a GM-added
  unflagged item survives untouched.
- **`mode: "create"` forces duplicate** even when a match exists.
- **`mode: "update"` with no existing match** → `VALIDATION` error, no actor
  created.
- **Ambiguous match** (two actors pre-seeded with the same `statblockKey`) →
  `VALIDATION`, `details.matchedActorIds` has both ids, neither actor touched.
- **Partial item-diff failure** → injected failure mid-diff; error carries
  `{actorId, stage: "itemDiff", cause}`; already-applied changes remain (not
  rolled back).

**Selftest:** extend the M6b leg (or add M6c) — import `test-archmage` once
(`created`), then again unmodified (`updated`, 0 item changes, verification
unchanged) as a live round-trip proof.

**Gate:** `npm run typecheck && npm test && npm run selftest`. No module
release needed (server-side orchestration only, same as the original
`import_npc` tool).

## Files touched

- `packages/statblock-sync/src/slug.ts` (new) — `statblockKey()`.
- `packages/statblock-sync/src/to-foundry.ts` — stamp `flags["foundry-mcp-bridge"].statblockKey`
  on the actor and on each synthesized item (Tier 3 path).
- `packages/statblock-sync/src/import-npc.ts` — `buildNpcUpdatePatch()`
  (statblock-owned patch builder); `importNpc()` gains upsert branching
  (match → patch + item-diff vs. create), plumbed through a new
  `mode` param and additional deps (`updateDocument`, `findActorItems`,
  `updateEmbeddedItem`, `deleteEmbeddedItem`) alongside the existing six.
- `packages/mcp-server/src/tools.ts` — `ImportNpcShape` gains `mode`;
  `runImportNpc()` performs the pre-import match query, wires the new deps to
  `runFindDocuments`/`runUpdateDocument`/`runUpdateEmbedded`/`runDeleteEmbedded`,
  and returns `action`/`itemChanges` in the output.
- `test/integration/import-npc-tool.test.ts` — new upsert/item-diff/mode
  tests (see Testing).
- `scripts/selftest.mjs` — extend tool-level leg with a second call proving
  idempotent re-sync.
