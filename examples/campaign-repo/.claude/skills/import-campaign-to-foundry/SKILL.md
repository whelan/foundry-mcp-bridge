---
name: import-campaign-to-foundry
description: Import Curse of Strahd campaign content into a running Foundry world via the foundry MCP tools — journals, NPCs/actors, scenes (with map upload), and quests, both locally and on The Forge. Use when the user wants to import, push, sync, build, populate, or create journals, NPCs, scenes, maps, or quests in Foundry (locally or on The Forge), or stage/upload assets to the Forge bucket.
---

# Import Curse of Strahd into Foundry (live MCP path)

This repo has two ways into Foundry: `scripts/import-*.js` (offline LevelDB, writes
the world DB directly) and the **foundry MCP tools** (`mcp__foundry__*`, the live
path into a running world with a GM logged in). **This skill uses the live MCP
path only.** Don't shell out to the LevelDB scripts unless the user explicitly asks.

## 0. Orient first — always

Call `get_world_info` once at the start of every session. It returns:
- `foundryVersion`, `system.id` (must be `dnd5e`), `world.id`/`world.title`
- `folders` — `{ _id, name, type }[]` for resolving a note's target folder by name
- `forge.active` — `true` when hosted on The Forge

**Derive the asset source from `forge.active` — never hardcode it:**
```
const source = worldInfo.forge.active ? "forgevtt" : "data";
```
Use this `source` for every `upload_asset`, `batch_upload_assets`, and
`browse_assets` call in the session.

## 1. Asset upload strategy (maps + tokens)

Upload images BEFORE creating the scenes/actors that reference them. Two paths:

| Tools | Goes through | When to use | `source` arg |
| --- | --- | --- | --- |
| `browse_assets` / `upload_asset` / `batch_upload_assets` | the running world (GM browser, via relay) | default; the world is open | `source` from `forge.active` (§0) |
| `forge_browse_assets` / `forge_upload_asset` / `forge_batch_upload_assets` / `forge_create_folder` | The Forge REST API directly (no world needed) | bulk pre-flight upload / folder setup before a GM is logged in | none — always Forge |

The `forge_*` tools need `FORGE_USER_ID` + `FORGE_API_KEY` configured (`.env`); without
them they return a structured `UNSUPPORTED` error naming the keys. Prefer the relay
tools when the world is open; reach for `forge_*` to stage assets without a GM.

**Paths come back ABSOLUTE on The Forge** (`https://assets.forge-vtt.com/<bucket>/worlds/<id>/…`).
Always reference the `path` the upload/browse call returns on the document — never
hand-build a `worlds/…` string, or it won't resolve on Forge.

### Pre-flight dedup
Browse first, then pass `skipExisting: true` so re-runs are idempotent. Dedup matches
by **basename**, so it skips correctly even when existing entries are absolute Forge URLs:
```
browse_assets({ source, target: "worlds/curse-of-strahd/scenes", extensions: [".webp",".jpg",".png"] })
// → { files: [".../worlds/curse-of-strahd/scenes/village-of-barovia.webp", ...], dirs: [...] }  // absolute URLs on Forge

batch_upload_assets({
  source,
  target: "worlds/curse-of-strahd/scenes",
  files: [
    { filename: "village-of-barovia.webp", contentBase64: "...", mimeType: "image/webp" },
    { filename: "death-house.webp",        contentBase64: "...", mimeType: "image/webp" },
  ],
  skipExisting: true,
})
// → [{ filename, path }, { filename, path, skipped: true }, ...]   ← use each returned `path`
```
Max 50 files per batch call — split larger sets into batches. Upload token art to
`worlds/curse-of-strahd/tokens/` the same way. (`forge_create_folder({ path })`
pre-creates a bucket folder when staging via REST.)

## 2. Document classification (by folder, not title)

| Source path | documentType | Tool | Notes |
| --- | --- | --- | --- |
| `generated/journals/*.md` | JournalEntry | create/update_document | GM notes (Danish). "Scene: …" titles are still journals, not maps. |
| `journals/*.md` | JournalEntry | update_document | Extracted from Foundry; ids/folders real → usually update. |
| `generated/npcs/*.md` | Actor | create/update_document | Strahd NPCs + monsters. |
| `generated/scenes/*.md` | Scene | create_scene / update_document | Actual maps; upload background first. |
| `actors/npcs/*.json` | Actor | create_document source | Full extracted JSON; strip `_id` for a fresh create or treat as upsert. |
| `actors/`, `journals/` (extracted), `rules/` | — | — | Reference. **Read-only — never write back.** |

## 3. Sync contract (authoritative)

**Don't hand-roll create-vs-update.** Reconcile through the **`foundry-sync`** skill,
which runs the deterministic `campaign-sync` planner over `foundry-sync.json` and
tells you exactly what to create / update / skip (and pulls quest progress back).
The manifest — not per-note front-matter — is the source of truth for ids, asset
paths, and drift. Run a plan before any bulk write; execute it Foundry-wins
(skip `remote-ahead`/`conflict`). See the `foundry-sync` skill for the workflow.

## 4. Scenes — full workflow

For each `generated/scenes/*.md`:
1. Parse front-matter: `name`, `id`, `width`, `height`, `gridSize`, `background`
   (a repo-relative image path).
2. Upload the background if not already present (see §1), capturing the stored path:
   ```
   const { path: bgPath } = upload_asset({ source, target: "worlds/curse-of-strahd/scenes",
     filename: "village-of-barovia.webp", contentBase64: readFileBase64(localPath) });
   ```
3. Create or update:
   - create: `create_scene({ name, width, height, gridSize, background: bgPath })` → write `_id` back.
   - update: `update_document({ documentType: "Scene", id, data: { background: bgPath } })`

### Strahd scene defaults (dnd5e)
```json
{ "gridSize": 100, "gridType": 1, "gridDistance": 5, "gridUnits": "ft", "padding": 0.25 }
```
Override per scene when front-matter says otherwise.

## 5. Actors / NPCs — full workflow

1. Parse the stat block: `name`, `type: "npc"`, CR, HP, ability scores.
2. Ensure the token image is uploaded (batch-upload all token art up front, §1) and
   **capture the returned `path`** — on Forge it's an absolute URL, so reuse it verbatim.
3. Create with dot-notation for nested fields, using that `tokenPath` for both `img`
   and the token texture (don't hardcode a relative `worlds/…` path — see §1):
   ```
   const tokenPath = /* the `path` returned by the upload for this token */;
   create_document({
     documentType: "Actor",
     data: {
       name: "Strahd von Zarovich",
       type: "npc",
       img: tokenPath,
       "prototypeToken.texture.src": tokenPath,
       "system.details.cr": 15,
       "system.attributes.hp.value": 144,
       "system.attributes.hp.max": 144,
     }
   })
   ```
4. Write `_id` back to front-matter.

## 6. Journal entries — full workflow

A `JournalEntry` is a container; its prose lives in embedded `JournalEntryPage`
documents (v10+). Two steps:
1. `create_document({ documentType: "JournalEntry", data: { name, folder: folderId } })` → `_id`.
2. `create_embedded({ parentType: "JournalEntry", parentId: _id,
   embeddedName: "JournalEntryPage", data: [{ name: "Description", type: "text",
   text: { content: "<p>…</p>" } }] })`
Convert the markdown body to HTML for `text.content` — never dump raw markdown.

## 7. Quest structure for Curse of Strahd

Map the story arc to a quest hierarchy. Create the main quest, capture its `_id`,
then create sub-quests with `parentId`:
```
const main = create_quest({ data: { name: "Curse of Strahd", status: "active",
  description: "Break the ancient curse that binds Barovia." } });
create_quest({ data: { name: "Escape Barovia", status: "hidden" }, parentId: main._id });
create_quest({ data: { name: "Defeat Strahd",  status: "hidden" }, parentId: main._id });
```
Suggested arc: main "Curse of Strahd" → sub-quests "Escape Barovia", "Defeat
Strahd", "Free the Souls". Use `update_quest({ id, data })` to flip status
(hidden → active → completed) as the party progresses.

NOTE on rewards: Forien's Quest Log manages rewards/tasks through its own internal
format, not arbitrary `data` fields — setting `data.rewards` may not populate the
FQL reward UI. Create the quest hierarchy via the tools; add item/gold/xp rewards
through FQL's own UI if the `data` route doesn't reflect them.

## 8. Editing, cloning & querying existing content

Beyond create/update, these round out world-building:

- `find_documents({ documentType, query })` — read or look up before creating; resolve
  an id by name (`query: { name: "…" }`) instead of guessing. Returns matches (or `[]`).
- `duplicate_document({ documentType, id, overrides })` — clone a finished actor/scene/
  journal for a variant (e.g. a reskinned monster) and rename via `overrides`.
- `update_embedded` / `delete_embedded({ parentType, parentId, embeddedName, … })` — edit
  or remove items, active effects, journal pages, or scene tokens after creation.
  `update_embedded` entries must each carry their `_id`.
- `delete_quest({ id })` — remove a quest; `update_quest` flips status as the party
  progresses (§7).

## 9. Guardrails

- **source from `worldInfo.forge.active`** — never hardcode `"data"`/`"forgevtt"`.
- **Show a plan before bulk writes.** For > 3 documents, print a table (file → op
  → name) and wait for go-ahead.
- **Deletes are terminal** — there's no rollback; confirm every delete with the user
  before running it, even though the tools are pre-approved.
- **No delete-asset tool** — uploaded images can't be removed via the bridge; prune them
  in the Forge/Foundry asset browser if needed.
- **Preserve language** — `generated/` notes are Danish; extracted `journals/` are
  English. Don't translate unless asked.
- Read each tool result's `ok`/`steps`; on a non-`ok` result surface `error.code`
  (`NOT_FOUND`, `VALIDATION`, `READBACK_MISMATCH`, `AUTH`, `TIMEOUT`, `UNSUPPORTED`) — don't blindly retry.
- **Token discipline (bulk imports).** Mutating tools echo a **slim** result by
  default (`_id`, `name`, `_stats.modifiedTime`) — that's all you need to write the
  `_id` back to front-matter; the read-back still verifies the whole document
  server-side. Do **not** pass `full: true` during a bulk import (it returns the
  entire document — a Scene with walls/lights/tokens, an Actor's full system data —
  into context, the dominant cost of a large import). Use `full: true` / `fields`
  only for the rare case you must inspect a written field.
- If `mcp__foundry__*` tools are absent the world isn't reachable: tell the user to
  start Foundry (GM logged in, `foundry-mcp-bridge` module enabled, matching relay
  URL/token). Don't fall back to the LevelDB scripts on your own.
