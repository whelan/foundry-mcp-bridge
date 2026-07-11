# Design: Tier 1 (compendium-clone) re-sync — refresh from compendium

**Date:** 2026-07-11
**Status:** Approved (brainstorming), pending implementation plan
**Follows:** `docs/superpowers/specs/2026-07-10-import-npc-resync-design.md` (Tier 3 upsert,
which named this as the documented Tier 1 follow-up)

## Goal

Make `import_npc` **update-aware for Tier 1 (compendium-clone) actors**. Re-importing a
note that matches an official compendium monster **refreshes the existing clone from the
current compendium** (e.g. picking up a new dnd5e system version), preserving
Foundry-owned runtime state — instead of the current behavior, which silently corrupts the
clone by overlaying Tier 3 synthesized data.

The chosen strategy is **refresh-from-compendium** (goal "B" from brainstorming): on
re-import the *compendium* is the source of truth. The note's mechanics are **not** applied
to a Tier 1 actor; the note's role is to trigger the reconcile and (by name) identify which
compendium entry to re-pull. Only `name`/`folder`/`image` from the note act as overrides.

## Non-goals

- **No "push statblock edits to a clone" (goal "C").** A Tier 1 actor is a clone plus
  refresh, never a clone-plus-note-overlay. If a user wants note mechanics to win, that is
  a separate future feature (Tier 1 would have to become an overlay at create time).
- **No actor-identity replacement.** The existing actor document is patched in place; its
  `_id` is preserved so placed tokens, journal links, and any ID references keep working.
  A "delete + re-clone fresh" approach was rejected because it mints a new `_id` and
  orphans already-placed tokens (preserving `prototypeToken` is not the same as preserving
  placed tokens).
- **No note-side identity / hashing / planner states.** Same boundary as the Tier 3
  design — this only makes the *tool call* idempotent for Tier 1; the caller decides when
  to re-call.
- **No conflict detection beyond read-back/rollback.** The existing dry-run → write →
  read-back → rollback contract is the only safety net if a GM is mid-edit.
- **No drift warning.** We do not diff the note's mechanics against the compendium to warn
  that note edits are being ignored; that is goal-C territory.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| What should Tier 1 re-sync do? | **Refresh from compendium** (goal B). Compendium is source of truth; note is trigger + name/folder/image override only. |
| Actor identity on refresh? | **Patch in place, preserve `_id`** (goal-A of Q2). Not delete + re-clone. |
| How to obtain fresh compendium data? | **New `getCompendiumDocument(uuid)` protocol command** (goal-A of Q3). Requires a Foundry module release. |
| Item reconciliation? | **Match-and-patch by source uuid** (goal-B of Q4). Preserves item `_id`s and per-item runtime. |
| Item provenance at create? | **Unify create on `getCompendiumDocument`** and stamp our own `sourceUuid` flag per item (goal-A of Q5). No dependency on Foundry's `_stats.compendiumSource`. |

## Architecture

### 1. Dispatch fix — store the tier (correctness, independent of the feature)

Today the `import_npc` update path (`importNpc`'s "UPDATE PATH") runs Tier-3 logic
unconditionally against *any* matched actor. Because Tier 1 clones **are** stamped with
`statblockKey`, `findActorsByKey` matches them, and re-importing a Tier-1 note currently:
`buildNpcUpdatePatch` overwrites the clone's AC/HP/abilities with *synthesized* values, and
`diffAndApplyItems` sees the compendium items as unflagged and **adds synthesized Tier 3
items on top of them** (duplicates). This path is untested.

Root cause: the actor records `statblockKey` but no **tier**. Fix — stamp tier and source
on the actor's flag at create:

```
flags["foundry-mcp-bridge"] = { statblockKey, tier: 1 | 3, compendiumUuid? }
```

On re-import, after `findActorsByKey` matches, branch the update path on the stored tier:
- `tier === 1` → **compendium-refresh path** (§4).
- `tier === 3` → existing **synthesis-diff path** (`buildNpcUpdatePatch` + `diffAndApplyItems`).
- `tier` absent → **infer** (§5, legacy self-upgrade).

Tier 3 create also starts stamping `tier: 3` for symmetry; absent is treated as "infer".

### 2. New protocol command: `getCompendiumDocument`

A read-by-uuid that returns a compendium actor's full source data:

```ts
// protocol.ts
{ action: "getCompendiumDocument", uuid: string }
// result data: { name: string; img?: string; system: object;
//                items: Array<{ uuid: string; name: string; type: string;
//                               img?: string; system: object; effects?: object[] }> }
```

Full lockstep per the `add-foundry-command` skill: shared zod schema → executor dispatch →
`FoundryDocumentApi` method → `foundry-runtime.ts` (`(await fromUuid(uuid)).toObject()`,
projecting each embedded item's own uuid) → mock (`mock-foundry.ts`) →
`mock-foundry-api.ts` → every test double of `FoundryDocumentApi`.

**This requires a Foundry module release** — including the separate public Forge module
repo (`whelan/foundry-mcp-bridge-module`) per the project's distribution setup. The Tier 3
`import_npc` work was server-side-only and needed no module release; this feature does.

### 3. Tier 1 create — rebuilt on `getCompendiumDocument`

Replace the whole-actor `importFromCompendium` clone with a build-from-data path:

1. `getCompendiumDocument(uuid)` for the matched entry.
2. Build the actor document from that data (system + items), stamping:
   - actor: `flags["foundry-mcp-bridge"] = { statblockKey, tier: 1, compendiumUuid: uuid }`
   - each item: `flags["foundry-mcp-bridge"] = { sourceUuid: <item uuid> }`
3. Create via the existing `createDocument` reliable path; apply `folder`/`image` overrides
   if supplied.

We know every item's source uuid directly, so provenance never depends on Foundry's
`_stats.compendiumSource`. **Fidelity risk to verify in the plan:** moving off Foundry's
clone means literal item creation must preserve item **active effects** (transfer flags,
etc.). The plan validates this against a real compendium monster with effect-bearing items.

### 4. Tier 1 refresh — in-place, `_id` preserved

On a matched Tier 1 upsert: fetch the fresh compendium doc (via stored `compendiumUuid`),
then reconcile.

**Actor fields.** Build a patch from the fresh `system` with runtime leaves stripped, then
send it through `updateDocumentReliable` (dry-run → write → read-back → rollback). Foundry's
update deep-merges, so stripped leaves are preserved and provided leaves are overwritten:

| Compendium-owned (refreshed) | Foundry-owned (stripped from patch, preserved) |
|---|---|
| all `system.*` not listed at right; `name` (fresh); `img`/`folder` only if supplied this call | `system.attributes.hp.value`, `.temp`, `.tempmax`; `system.attributes.exhaustion`; `system.currency`; `effects`; `prototypeToken`; `ownership`; `_stats`; `flags` (our provenance preserved as-is) |

New helper `buildCompendiumRefreshPatch(freshDoc, resolvedImagePath?, folderId?)` in
`import-npc.ts` produces this dot-notation/nested patch; runtime carve-outs are a single
explicit path list reused by the tests.

**Items.** Match existing items carrying our `sourceUuid` flag against the fresh compendium
item list (by uuid):

| Case | Action |
|------|--------|
| source uuid in both existing (flagged) and fresh | `updateEmbedded` patch `{name, img, system}` with **item-runtime carve-outs stripped** (`system.uses.spent`, `system.equipped`, `system.attunement`); `_id` + runtime preserved |
| source uuid only in fresh | build item + `createEmbedded`, stamp `sourceUuid` flag |
| our-flagged, source uuid gone from fresh compendium | `deleteEmbedded` |
| unflagged (GM-added) | untouched, always |

Unchanged detection reuses the `isSubset(actual, expected)` comparison already used by
`diffAndApplyItems` (a real dnd5e item is normalized with derived fields our data never
populates, so subset — not equality — is what "nothing meaningful changed" means).

**Partial-failure contract** stays consistent with today's item-diff/spell-attach: a
mid-reconcile throw carries `{actorId, stage: "itemDiff", cause}`; already-applied item
changes and the actor patch are **not** rolled back (a half-applied refresh is still better
data than none).

### 5. Legacy Tier 1 actors (no data migration)

Actors created before this feature have `statblockKey` but no `tier`/`compendiumUuid`, and
their items are unstamped. On re-import with `tier` absent:

1. Infer via `matchStatblock(statblock, await searchCompendium(name))`.
2. **Exact compendium match ⇒ Tier 1.** Run the refresh (§4), and on this first (upgrade)
   pass: backfill the actor's `{tier:1, compendiumUuid}` flags, and stamp `sourceUuid` on
   items by matching to the fresh compendium items by name (falling back to
   `_stats.compendiumSource` when present). Subsequent re-imports match by our own flag.
3. **No exact match ⇒ Tier 3** → existing synthesis-diff path.

The first re-import self-upgrades; no separate migration step or world scan is needed.

### 6. API / output / errors

**Input** unchanged — the `mode` param (`"upsert"` | `"create"` | `"update"`) already
exists from the Tier 3 work and applies identically.

**Output** — the existing shape already carries the needed fields:
```ts
{
  actorId: string;
  tier: 1 | 3;
  matchedUuid?: string;   // = compendiumUuid on a Tier 1 refresh
  action: "created" | "updated";
  itemChanges?: { created: number; updated: number; deleted: number; unchanged: number };
  verification: { ok: boolean; checks: [...] };
}
```
A Tier 1 refresh returns `tier:1, action:"updated", matchedUuid: compendiumUuid,
itemChanges:{…}`.

**New error case:** stored `compendiumUuid` no longer resolves (compendium/pack removed) →
`VALIDATION` (or `INTERNAL`), `details.compendiumUuid`. Existing errors (ambiguous match,
`mode:"update"` no-match) are unchanged.

## Testing

**Unit:**
- `getCompendiumDocument` executor dispatch (guards + delegates to `FoundryDocumentApi`).
- `buildCompendiumRefreshPatch` strips exactly the runtime carve-out leaves and includes
  the compendium-owned ones; `img`/`folder` only when supplied.
- Item match-and-patch diff (create/update/delete/unchanged partition by `sourceUuid`).

**Integration — `runImportNpc()` against MockFoundry** (extends
`test/integration/import-npc-tool.test.ts`):
- **First Tier 1 import stamps tier+source.** `action:"created"`, `tier:1`; actor carries
  `{statblockKey, tier:1, compendiumUuid}`, each item carries `{sourceUuid}`.
- **Re-import unchanged → refresh no-op.** `action:"updated"`, `itemChanges` all-zero
  except `unchanged`; Foundry-owned runtime (current HP value, injected effect, token
  name, currency) preserved across the call; actor `_id` and item `_id`s stable.
- **Compendium changed → refresh applies.** Mock compendium doc mutated (one item's damage
  changed, one item added, one removed) → actor fields + `itemChanges` reflect exactly the
  compendium delta; a GM-added unflagged item survives untouched.
- **Legacy self-upgrade.** Actor pre-seeded with only `statblockKey` (no tier), items
  unstamped → re-import infers Tier 1, backfills flags + item `sourceUuid`, refreshes.
- **`mode:"update"` no match** → `VALIDATION`, no actor created (unchanged).
- **Missing compendium uuid** → `VALIDATION`/`INTERNAL` with `details.compendiumUuid`.

**Mock-fidelity note (per memory `live-forge-check-after-module-changes`):** provenance
stamping and build-from-data item **active effects** work in mock but `foundry-runtime.ts`
is not run by CI. A selftest leg **and** a live Forge check are required before this is
"done" — specifically confirming that a build-from-data Tier 1 actor has working
effect-bearing items and that a refresh preserves runtime.

**Selftest:** add a leg that imports a real compendium monster (Tier 1) once
(`created`, `tier:1`), then again unmodified (`updated`, 0 item changes, runtime preserved)
as a live round-trip proof.

**Gate:** `npm run typecheck && npm test && npm run selftest` **plus a Foundry module
release** (new protocol command) — unlike the Tier 3 work, which was server-side only.

## Files touched

- `packages/shared/src/protocol.ts` — add `GetCompendiumDocumentCommand` to the `Command`
  union + result typing.
- `packages/foundry-module/src/protocol-executor.ts` — dispatch `getCompendiumDocument`.
- `packages/foundry-module/src/foundry-runtime.ts` — real `getCompendiumDocument`
  (`fromUuid` + `toObject`, project item uuids). *(Not in CI — live-verify.)*
- `packages/foundry-module/src/*` `FoundryDocumentApi` interface — new method.
- `test/integration/mock-foundry.ts` + `mock-foundry-api.ts` — mock `getCompendiumDocument`
  (compendium actor store with per-item uuids).
- every test double of `FoundryDocumentApi` — new method (keeps `tsconfig.test.json` green).
- `packages/statblock-sync/src/import-npc.ts` — tier-branched update path;
  `buildCompendiumRefreshPatch`; item match-and-patch; create rebuilt on
  `getCompendiumDocument` with provenance stamping; legacy tier inference; new dep
  `getCompendiumDocument`.
- `packages/statblock-sync/src/match.ts` — unchanged shape (still returns `{tier,uuid}`).
- `packages/mcp-server/src/tools.ts` — wire `getCompendiumDocument` dep, stamp/branch on
  tier, return `tier:1` refresh output.
- `test/integration/import-npc-tool.test.ts` — new Tier 1 create/refresh/legacy tests.
- `scripts/selftest.mjs` — Tier 1 import-then-refresh leg.
