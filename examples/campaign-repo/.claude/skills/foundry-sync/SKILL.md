---
name: foundry-sync
description: Use when reconciling a campaign notes repo with a live Foundry world — before importing/updating documents or quests, or when the user asks to "sync", "reconcile", "check drift", "what changed", or "pull quest progress". Produces a plan (create/update/unchanged/remote-ahead/conflict) via the campaign-sync planner, executes it Foundry-wins, and pulls quest progress back to the repo.
---

# Foundry sync (deterministic reconcile)

Keeps `foundry-sync.json` (manifest of ids + asset paths + hashes + remote
`modifiedTime`) authoritative. The plan is computed by the **campaign-sync CLI**
in the bridge — never improvise the diff. Bridge path = the absolute path in
`.mcp.json`; the CLI is at `<bridge>/packages/campaign-sync/dist/cli.js`.

## Workflow

1. `get_world_info` → if `world.id` ≠ the manifest's `world.id`, **STOP** (every id
   points at a different world). Otherwise continue.
2. Build live state. For each tracked `documentType`, `find_documents` to read
   `_stats.modifiedTime`; for quests, `find_documents({ documentType: "JournalEntry",
   query: { folder: <_fql_quests folder id from get_world_info> } })` and keep each
   entry's `flags["forien-quest-log"].json`. Write a `live.json`:
   `{ "world": { "id": "<world.id>" }, "docs": { "<foundryId>": { "foundryId", "modifiedTime", "quest"? } } }`.
3. Run the planner:
   `node <bridge>/packages/campaign-sync/dist/cli.js plan --notes . --manifest foundry-sync.json --live live.json --system <system.id> --forge <true|false>`
   It prints a table (stderr) + plan JSON (stdout).
4. Present the table. For > 3 writes, wait for go-ahead.
5. Execute per item (see table). **Skip** `remote-ahead` and `conflict` (Foundry wins);
   report them so the user can fold the change back into the repo.
6. After writes, build a `results.json` (`{ "<source>": <ManifestEntity> }`) from each
   write's read-back (`_stats.modifiedTime` → `remoteModifiedTime`, new ids, content
   hash from the plan, asset `remotePath`s, quest `progressHash`), then
   `node <bridge>/.../cli.js record --manifest foundry-sync.json --results results.json --live live.json`.
7. For quest `*-pull-progress` items, write the live progress into the quest note's
   front-matter (`status`, `tasks: [{name, completed}]`) — leave the prose body alone.
8. Commit `foundry-sync.json` and any changed notes.

## Action → tool

| Plan action | Do |
| --- | --- |
| `create` | `create_document` / `create_scene` / `create_quest`; record returned `_id` |
| `update` | `update_document` (partial) |
| `quest-push-structure` | `update_quest` with **structure fields only** (name/description/hierarchy) |
| `quest-pull-progress` | pull live `status` + tasks into the note front-matter |
| `quest-push-and-pull` | both of the above |
| `remote-ahead` / `conflict` | **skip + report** (Foundry wins) |
| `missing-remote` | report; recreate only after explicit confirmation |
| `unchanged` | nothing |

## Guardrails

- Never hand-compute the diff — always run the CLI planner.
- `update_quest` must send only structure fields, never `status`/`tasks` (those are
  world-owned; pushing them would clobber live progress).
- Deletes are terminal — confirm with the user before any delete.
- Surface `error.code` on a non-`ok` result; never blind-retry.
