# Foundry campaign sync — design spec

**Date:** 2026-06-20
**Status:** Approved (brainstorming) — ready for implementation plan
**Topic:** A deterministic reconcile/sync safeguard between a campaign notes repo
and a running Foundry world (local or The Forge), keeping document ids and asset
paths in sync and surfacing what changed on each side.

## 1. Problem & goals

The `import-campaign-to-foundry` skill currently pushes notes into a live world
with a thin per-note "upsert contract": empty front-matter `id` → create + write
the id back; filled `id` → update. This tracks **ids only, per note**. It does
not record **asset paths**, and it has **no drift detection** — a GM edit made in
Foundry is silently overwritten on the next import.

Goals:

1. **Full reconcile.** A single, committed manifest that maps every imported
   entity (documents *and* uploaded assets) to its Foundry id / Forge path, plus
   enough state to compute a plan and detect drift on both sides.
2. **Drift awareness.** Before any write, classify each entity as
   create / update / unchanged / remote-ahead / conflict and present the plan, so
   the user knows exactly what will change.
3. **Foundry-wins conflict policy.** When a document changed on both sides, the
   live world's edit is preserved (skip + report); never clobber a live edit.
4. **Quest progress pulls back to the repo.** Quest progress (status, task
   check-offs) is owned by the live world as players act on it. It must flow
   Foundry → repo so sessions can be planned from up-to-date state.
5. **Deterministic.** The plan/diff is computed by code, not improvised by the
   model each run, so it is trustworthy and reviewable.

## 2. Decisions locked during brainstorming

| Decision | Choice |
| --- | --- |
| Scope of the safeguard | Full reconcile (manifest + plan/diff + conflict detection) |
| Conflict policy (document changed both sides) | **Foundry wins** — skip the write, report it |
| Coverage | Documents (by id) **and** assets (by path + content hash) |
| Build approach | **Script-backed from the start** — deterministic planner in code |
| Quest sync | **Bidirectional**, field-ownership split (structure pushes, progress pulls) |

## 3. Architecture overview (answers "should the skill be split?")

Split **only along the sync responsibility**, not per document type (splitting
per type would fragment the shared conventions — orient, source rule, paths,
guardrails — that every type needs). Three units:

- **`packages/campaign-sync`** (new, in the bridge) — the deterministic core.
  Testable pure functions + a thin CLI. Defines its own `EntityType` (the imported
  Foundry `DocumentType`s plus `Quest`); reuses `packages/shared`'s `DocumentType`
  for the Foundry-document subset. Invoked from the notes repo by absolute path,
  the same way `.mcp.json` already references the bridge.
- **`foundry-sync` skill** (new, in the campaign-repo template) — owns the
  manifest + plan workflow: orchestrates the MCP reads/writes ↔ the CLI.
- **`import-campaign-to-foundry` skill** (existing) — stays as the per-type
  recipe for *how to build* each document. Its §3 upsert contract is **replaced**
  by "run the planner". The two skills share one manifest.

The manifest (`foundry-sync.json`) lives in the **notes repo** (committed); the
planner lives in the **bridge** (tested there). The notes repo stays clean — only
the manifest file is added.

## 4. The sync manifest (`foundry-sync.json`)

Single source of truth, git-diffable, lives at the notes-repo root.

```json
{
  "version": 1,
  "world": { "id": "curse-of-strahd", "system": "dnd5e", "forge": true },
  "entities": {
    "generated/npcs/strahd.md": {
      "documentType": "Actor",
      "foundryId": "OY1GPYw1bt1vyS2Q",
      "contentHash": "sha256:…",
      "remoteModifiedTime": 1781963876080,
      "lastImportedAt": "2026-06-20T16:00:00Z",
      "assets": [
        {
          "localPath": "art/tokens/strahd.webp",
          "contentHash": "sha256:…",
          "remotePath": "https://assets.forge-vtt.com/<bucket>/worlds/curse-of-strahd/tokens/strahd.webp"
        }
      ]
    },
    "generated/quests/escape-barovia.md": {
      "documentType": "Quest",
      "foundryId": "508O4p7zIb94Gy1b",
      "contentHash": "sha256:…",
      "remoteModifiedTime": 1781965310248,
      "progressHash": "sha256:…",
      "lastImportedAt": "2026-06-20T16:00:00Z",
      "assets": []
    }
  }
}
```

- **Key** = repo-relative source path (stable across runs; one note → one entity).
- `documentType` = one of the imported Foundry `DocumentType`s (`Actor`, `Scene`,
  `JournalEntry`, …) **or** the logical type `Quest` (FQL-backed; see §5.2).
- `contentHash` = hash of the normalized source content used to build the
  document (detects local edits).
- `remoteModifiedTime` = the live doc's `_stats.modifiedTime` recorded at the last
  import (detects remote edits). Verified present on every document type,
  **including quests** (see §5.2).
- `progressHash` (quests only) = hash of the pulled progress fields; detects when
  live progress changed.
- `assets[]` = per-entity asset records: local hash + the absolute Forge
  `remotePath` returned by the upload.

## 5. Plan algorithm

The planner is pure: `computePlan(manifest, repoEntities, liveState) → Plan`. It
takes the manifest, the repo entities (paths + content hashes + classified type),
and a snapshot of live Foundry state (fetched by the skill via `find_documents` /
`get_world_info`). It emits a per-entity classification.

### 5.1 Documents (Actor / Scene / JournalEntry) — push-primary, Foundry-wins

Given manifest entry `M`, repo content `R` (hash), live doc `L` (`modifiedTime`):

| State | Classification | Action |
| --- | --- | --- |
| no `M`, no `L` | **create** | write; record id + `modifiedTime` |
| `M`, but `L` missing (deleted in Foundry) | **missing-remote** | report; recreate only after confirmation |
| `M`+`L`, nothing changed | **unchanged** | skip |
| only repo changed (`R.hash ≠ M`) | **update** | push repo → Foundry |
| only Foundry changed (`L.mtime ≠ M`) | **remote-ahead** | **skip + report** (Foundry wins) |
| changed both sides | **conflict** | **skip + report loudly** (Foundry wins) |
| asset local hash ≠ manifest | **reupload** | upload; record new `remotePath` |

### 5.2 Quests — bidirectional, field-ownership split

FQL stores each quest as a **JournalEntry** in the `_fql_quests` folder; the quest
object lives in `flags["forien-quest-log"].json`, and the JournalEntry carries
`_stats.modifiedTime`. (Verified empirically against a live Forge world on
2026-06-20.) So quests are readable via
`find_documents({ documentType: "JournalEntry", query: { folder: <_fql_quests id> } })`
and drift-detectable — no new bridge tool required; the planner extracts the flag
from the live-state JSON.

Field ownership is split, which dissolves quest conflicts entirely:

| Field class | Owner | Direction | Fields |
| --- | --- | --- | --- |
| **Structure / shell** | repo | push → Foundry | `name`, `description`, `giver`, hierarchy (`parent` / subquests) |
| **Tasks + progress** | live world | pull → repo | `status`, each `task.completed` / `task.failed`, `date.start` / `date.end` |

Rationale: FQL tasks/rewards cannot be reliably authored through the bridge's
`*_quest` tools (FQL owns that format), so tasks are **mirrored** from Foundry into
the repo. `update_quest` is a *partial* update, so pushing only structure fields
never clobbers live progress.

| State | Action |
| --- | --- |
| repo shell changed | push structure (`update_quest`, structure fields only) |
| live progress changed (`modifiedTime` / `progressHash` ≠ manifest) | **pull** status + tasks → note front-matter |
| both | push structure **and** pull progress (no conflict) |

Pulled progress lands in:

- The quest note's **front-matter** (`status`, `tasks: [{ name, completed }]`),
  regenerated each pull; the prose body is left untouched.
- The manifest (`remoteModifiedTime` + `progressHash`).
- *Optional, cheap:* a generated `quests-status.md` rollup — one table of all
  quests' status / check-offs for session planning.

## 6. Reconcile workflow (orchestration by the `foundry-sync` skill)

1. `get_world_info` → **hard stop if `world.id` ≠ the manifest's** (otherwise every
   recorded id points at a different world — the most important safety check).
2. `find_documents` per tracked type (and the `_fql_quests` folder for quests) →
   dump live `modifiedTime` + quest flags to a live-state JSON.
3. CLI `plan` → prints the plan (human table + machine-readable JSON).
4. Present the plan; for > 3 writes, wait for go-ahead (existing guardrail).
5. Execute: create/update via MCP tools; **skip** remote-ahead + conflicts; **pull**
   quest progress into notes.
6. CLI `record` → update the manifest from the write read-backs (new ids, content
   hashes, `modifiedTime`, asset `remotePath`, quest `progressHash`).
7. Commit `foundry-sync.json` (and any pulled note changes).

## 7. Components & boundaries (`packages/campaign-sync`)

- **`planner.ts`** — pure core. `computePlan(manifest, repoEntities, liveState) →
  Plan`. No I/O. The unit-tested heart (mirrors the repo's `protocol-executor` /
  `reliability` "testable core" convention).
- **`manifest.ts`** — zod schema + read/write/validate `foundry-sync.json`.
- **`notes.ts`** — parse note front-matter + body, classify type by folder (config
  map), compute content hash (`node:crypto`).
- **`fql.ts`** — extract the quest object from a JournalEntry's
  `flags["forien-quest-log"].json`; compute the progress hash; render the
  front-matter progress block.
- **`cli.ts`** — thin wrapper exposing `plan` and `record` subcommands; reads the
  live-state JSON on stdin / from a path. No business logic.

Each unit answers: what it does, how it is used, what it depends on — and the
planner can be understood and tested without any Foundry or filesystem access.

## 8. Error handling & safety

- **World mismatch** → hard stop before any read/write (§6.1).
- **Foundry wins** → conflicts and remote-ahead documents are never written; they
  are reported so the user can fold the change back into the repo.
- **Missing remote** (manifest has an id but the doc is gone) → reported, not
  silently recreated.
- Reuse the existing tool error taxonomy (`NOT_FOUND`, `VALIDATION`,
  `READBACK_MISMATCH`, `AUTH`, `TIMEOUT`, `UNSUPPORTED`); surface `error.code`,
  never blind-retry.
- The planner is deterministic and side-effect-free; only the skill performs
  writes, and only after the plan is shown.

## 9. Testing

- **Planner unit tests** (vitest, fixtures): every row of §5.1 and §5.2, plus the
  quest field-ownership split, the world-mismatch hard stop, and asset reupload —
  driven by `(manifest × repoEntities × liveState) → expected Plan`. No live
  Foundry needed.
- **Manifest schema tests** — round-trip + rejection of malformed manifests.
- **`fql.ts` tests** — extract progress from a captured `_fql_quests` JournalEntry
  fixture (the real shape captured on 2026-06-20).
- **CLI smoke test** — `plan` and `record` over a tiny fixture repo.
- Gate via `verify-bridge` (build → typecheck → test). No selftest change needed
  (this path does not touch the live relay protocol).

## 10. Out of scope (YAGNI)

- Auto-merging live document edits back into notes for non-quest types (we *report*
  remote-ahead / conflicts; manual merge for now). Can be added later without a
  manifest schema change.
- Authoring FQL tasks/rewards from the repo (FQL owns that format; tasks are
  pull-only).
- A standalone "read quests" MCP tool — `find_documents` on `_fql_quests` suffices.

## 11. Risks / open questions

- **FQL internal format** may differ across FQL versions (flag path / task shape).
  Mitigation: isolate all FQL knowledge in `fql.ts` behind a small parser with a
  fixture test; fail loudly on an unrecognized shape.
- **Task identity for pull** — if FQL tasks have no stable id, match by name when
  writing progress into note front-matter; document the limitation.
- **Quest hierarchy** (`parent`/subquests) push ordering — create parents before
  children (the planner emits writes in dependency order).
