---
name: import-campaign-to-foundry
description: Import Curse of Strahd campaign content into a running Foundry world via the foundry MCP tools — journals, NPCs/actors, scenes (with map upload), and quests, both locally and on The Forge. Use when the user says "import", "push", "sync", or "create in Foundry" for journals, NPCs, scenes, maps, or quests.
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

Upload images BEFORE creating the scenes/actors that reference them.

### Pre-flight dedup
Call `browse_assets` to see what's already uploaded, then pass `skipExisting: true`
so re-runs are idempotent:
```
browse_assets({ source, target: "worlds/curse-of-strahd/scenes", extensions: [".webp",".jpg",".png"] })
// → { files: ["worlds/curse-of-strahd/scenes/village-of-barovia.webp", ...], dirs: [...] }

batch_upload_assets({
  source,
  target: "worlds/curse-of-strahd/scenes",
  files: [
    { filename: "village-of-barovia.webp", contentBase64: "...", mimeType: "image/webp" },
    { filename: "death-house.webp",        contentBase64: "...", mimeType: "image/webp" },
  ],
  skipExisting: true,
})
// → [{ filename, path }, { filename, path, skipped: true }, ...]
```
Max 50 files per `batch_upload_assets` call — split larger sets into batches.
Upload token art to `worlds/curse-of-strahd/tokens/` the same way.

## 2. Document classification (by folder, not title)

| Source path | documentType | Tool | Notes |
| --- | --- | --- | --- |
| `generated/journals/*.md` | JournalEntry | create/update_document | GM notes (Danish). "Scene: …" titles are still journals, not maps. |
| `journals/*.md` | JournalEntry | update_document | Extracted from Foundry; ids/folders real → usually update. |
| `generated/npcs/*.md` | Actor | create/update_document | Strahd NPCs + monsters. |
| `generated/scenes/*.md` | Scene | create_scene / update_document | Actual maps; upload background first. |
| `actors/npcs/*.json` | Actor | create_document source | Full extracted JSON; strip `_id` for a fresh create or treat as upsert. |
| `actors/`, `journals/` (extracted), `rules/` | — | — | Reference. **Read-only — never write back.** |

## 3. Upsert contract (authoritative)

- **`id: ""`** → `create_document` (or `create_scene`). On success, **write the
  returned `_id` back into the note's front-matter** so the next run updates.
- **`id: "<16-char>"`** → `update_document` `{ documentType, id, data }`. If it
  returns `NOT_FOUND` (doc not in this world) and you want stable cross-refs,
  `create_document` with `data._id` set and `keepId: true`.
The id round-trip is what keeps imports idempotent — never skip writing it back.

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
2. Ensure the token image is uploaded (batch-upload all token art up front, §1).
3. Create with dot-notation for nested fields and the token texture:
   ```
   create_document({
     documentType: "Actor",
     data: {
       name: "Strahd von Zarovich",
       type: "npc",
       img: "worlds/curse-of-strahd/tokens/strahd-von-zarovich.webp",
       "prototypeToken.texture.src": "worlds/curse-of-strahd/tokens/strahd-von-zarovich.webp",
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

## 8. Guardrails

- **source from `worldInfo.forge.active`** — never hardcode `"data"`/`"forgevtt"`.
- **Show a plan before bulk writes.** For > 3 documents, print a table (file → op
  → name) and wait for go-ahead.
- **Deletes are terminal** — confirm every delete explicitly; they aren't auto-allowed.
- **Preserve language** — `generated/` notes are Danish; extracted `journals/` are
  English. Don't translate unless asked.
- Read each tool result's `ok`/`steps`; on a non-`ok` result surface `error.code`
  (`NOT_FOUND`, `VALIDATION`, `READBACK_MISMATCH`, `AUTH`, `TIMEOUT`) — don't blindly retry.
- If `mcp__foundry__*` tools are absent the world isn't reachable: tell the user to
  start Foundry (GM logged in, `foundry-mcp-bridge` module enabled, matching relay
  URL/token). Don't fall back to the LevelDB scripts on your own.
