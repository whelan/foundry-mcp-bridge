# Design: `import_npc` MCP tool

**Date:** 2026-07-10
**Status:** Approved (brainstorming), pending implementation plan

## Goal

Expose the existing `statblock-sync` `importNpc()` flow as a single MCP tool so a
Fantasy Statblocks note can be imported into a live Foundry world — actor +
rollable action items + resolved spells + optional portrait — in one call,
instead of the piecewise `create_document` + `create_embedded` +
`import_embedded_from_compendium` sequence a caller must orchestrate by hand.

## Non-goals

- **No re-sync / update semantics.** Every call creates a new actor (Foundry
  will happily hold two "Young Ash Wyrm"s). Name-collision detection, replace,
  and field-ownership merging are Phase 4 territory (see
  `docs/obsidian-statblock-npc-sync-plan.md`), explicitly out of scope here.
- **No new wire command, no Foundry-module change.** The whole flow is
  server-side orchestration over tool runners that already exist. The module
  stays at v0.1.3; no release is cut for this work.
- **No lint-and-warn softening.** A note with 2014-style action text is
  *rejected*, not imported-with-warnings (decision below).
- **No innate spellcasting, Tier 2 item matching, or Foundry→statblock export.**
  Those are separate follow-ups; this tool wires up what `importNpc()` already
  does.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Expose optional portrait image? | **Yes** — optional `image: {filename, contentBase64}` param. |
| What does the tool return? | **Always verify** — re-read the actor and include a `verifyImportedNpc` report. Failed checks do not undo the import. |
| Run the statblock lint gate? | **Lint and reject** — 2014-style / malformed action text ⇒ `VALIDATION` error before any write. |
| Name collisions? | **Always create** — no collision logic; duplicates are the caller's concern. |

## Architecture

The tool is **pure server-side orchestration**. `importNpc()` already takes six
injected dependencies; each maps 1:1 onto an existing mcp-server tool runner over
the same `RelayTransport`. This is the exact `realDeps()` pattern already proven
in `test/integration/statblock-import.test.ts:45` and `scripts/selftest.mjs`.

```
runImportNpc(transport, input)
  1. lintStatblockNote(markdown)            → any FAIL ⇒ VALIDATION (details.findings), no write
  2. parseStatblock(markdown)               → zod-validated StatblockData (VALIDATION on failure)
  3. importNpc(statblock, deps, image?)     → deps wired to existing runners:
       searchCompendium             → runSearchCompendium      (Actor tier match)
       importFromCompendium         → runImportFromCompendium  (Tier 1 clone)
       createDocument               → runCreateDocument        (Tier 3 synthesis)
       uploadImage                  → runUploadAsset            (portrait, when image given)
       searchSpellCompendium        → runSearchCompendium       (Item)
       importEmbeddedFromCompendium → runImportEmbeddedFromCompendium
       createEmbeddedItem           → runCreateEmbedded         (placeholder spells)
  4. runFindDocuments(actorId, full:true)   → read-back the created actor
  5. verifyImportedNpc(readBack, statblock) → verification report
```

Every sub-step still flows through its own reliability pipeline (dry-run → write
→ read-back → rollback), so the orchestration inherits those guarantees per step.

### Structural changes

- `packages/mcp-server/package.json` gains a workspace dependency on
  `@foundry-mcp-bridge/statblock-sync`.
- The per-note lint logic currently inline in `scripts/lint-statblock.mjs` is
  **extracted into `statblock-sync` as an exported
  `lintStatblockNote(markdown: string): LintFinding[]`**. Both the CLI script and
  the new tool consume it — single source of truth preserved. The
  write-statblock `.cjs` bundle is regenerated
  (`npm run bundle:write-statblock-skill`).
- New tool registered in `packages/mcp-server/src/server.ts`; `ImportNpcShape`
  (zod input) + `runImportNpc()` added to `packages/mcp-server/src/tools.ts`.

## Input / output

**Input** (`ImportNpcShape`):
```ts
{
  markdown: string;                                       // the note, ```statblock fence included
  image?: { filename: string; contentBase64: string };    // optional portrait
  assetSource?: "data" | "forgevtt";                       // where uploadImage writes; default "data"
}
```

**Success output:**
```ts
{
  actorId: string;
  tier: 1 | 3;
  matchedUuid?: string;                 // present when tier === 1
  verification: {
    ok: boolean;
    checks: Array<{ name: string; pass: boolean; got?: unknown; want?: unknown }>;
  };
}
```

`verification.ok === false` is **still a success** (`ok: true` at the tool
level): the actor was created; verification is a report, not a gate. This
mirrors the selftest's `test-archmage` leg, which imports cleanly but flags the
deliberately misspelled "fli" spell.

## Error handling

Failures fall into four buckets:

1. **Pre-write (clean, nothing created):**
   - Lint FAIL → `VALIDATION`, `details.findings: [{action, problem}]`.
   - Parse / zod failure → `VALIDATION`, `details` summarizing the bad field.

2. **Actor-create failure (nothing to clean up):** the Tier 1 clone or Tier 3
   create fails inside its own reliability pipeline, which already rolled back.
   The tool surfaces the underlying code (`NOT_FOUND`, `READBACK_MISMATCH`,
   `TIMEOUT`, …) unchanged. No actor exists.

3. **Post-actor failure (partial actor — the hard case):** the actor exists but a
   later stage (spell attach, image upload) throws. Per "always create" we do
   **not** auto-delete — a half-built actor may be a correct Tier-1 clone whose
   only problem was one placeholder spell, and silently deleting it discards good
   data. The tool returns a structured partial-success error:
   ```ts
   error.code = "INTERNAL"
   error.details = { actorId, stage, cause }   // stage e.g. "attachSpells"
   ```
   `actorId` is always included when an actor was created, so the caller can
   inspect or `delete_document` it. This follows the repo's "report faithfully,
   let the operator decide" ethos.

   To produce `stage`, `runImportNpc` wraps the two phases (actor-create vs.
   spell-attach) in try/catch **in the tool**, not in the library —
   `importNpc()` itself stays unchanged.

4. **Verification failures are not errors** (see output section).

## Testing

**Unit — `lintStatblockNote()`** (new library export): a 2024-clean note → `[]`;
a 2014-phrased attack ("Melee Weapon Attack: +5 to hit") → one FAIL finding; a
malformed save header → FAIL. Then thin `scripts/lint-statblock.mjs` to consume
it and regenerate the `.cjs` bundle. Guards the single-source-of-truth invariant.

**Integration — `runImportNpc()` against MockFoundry** (new
`test/integration/import-npc-tool.test.ts`), calling the *tool* (not
`importNpc()` directly):
- **Tier 3 + spells** (`test-archmage.md`) → `ok`, `tier: 3`,
  `verification.checks` includes the "fli" failure, `verification.ok === false`.
- **Tier 1** (`gravemire-stalker.md`, seeded compendium) → `tier: 1`,
  `matchedUuid` set.
- **Lint reject** (a fixture with 2014 text) → `VALIDATION`, findings present,
  **zero** actors created in the mock.
- **Partial-failure** — drive a spell-attach throw. MockFoundry's `injectFailure`
  is a one-shot queue consumed by the *next* `execute()`, so the test must queue
  the throw *after* the actor-create calls have run (e.g. a small MockTransport
  wrapper that arms the failure once a `createEmbedded`/`importEmbeddedFromCompendium`
  envelope is seen, or a counted offset). Assert the error carries
  `details.actorId` + `stage: "attachSpells"` and the actor is still present in
  the mock. (The exact arming mechanism is an implementation-plan detail; the
  capability exists.)
- **Image** (`gravemire-stalker` + its `.png`) → portrait path set on read-back.

**Selftest — new leg:** `scripts/selftest.mjs` already drives the three fixtures
through `importNpc()` directly; add a parallel leg driving one fixture through
`runImportNpc(markdown)` end-to-end (server → relay → module → read-back), proving
the tool-level entry point over the wire.

**Gate:** `npm run typecheck && npm test && npm run selftest`. No
`bundle:module` needed (module unchanged). A single optional live-Forge import of
a fresh note can confirm at the end, but no module release is involved.

## Files touched

- `packages/statblock-sync/src/lint.ts` (new) — `lintStatblockNote()`, extracted
  from the CLI script; exported from `index.ts`.
- `scripts/lint-statblock.mjs` — thinned to consume `lintStatblockNote()`.
- `.claude/skills/write-statblock/lint-statblock.bundle.cjs` — regenerated.
- `packages/mcp-server/package.json` — add `statblock-sync` workspace dep.
- `packages/mcp-server/src/tools.ts` — `ImportNpcShape` + `runImportNpc()`.
- `packages/mcp-server/src/server.ts` — register `import_npc`.
- `test/integration/import-npc-tool.test.ts` (new) — pipeline tests.
- `scripts/selftest.mjs` — new tool-level leg.
- `docs/command-lifecycle.md` — note the tool is orchestration-only (no wire
  command), if the command table lists tools.
