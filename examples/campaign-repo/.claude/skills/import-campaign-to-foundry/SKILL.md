---
name: import-campaign-to-foundry
description: Turn this repo's campaign notes (markdown/frontmatter) into documents in the running Foundry world via the foundry MCP tools. Use when the user wants to "import", "push", "sync", or "create in Foundry" their NPCs, locations/scenes, handouts/lore, items, roll tables, or quests — e.g. "import the NPCs in npcs/ into Foundry", "create a scene for the tavern", "sync this session's notes".
---

# Import campaign notes into Foundry

This repo holds campaign content as files; the **foundry** MCP server exposes
tools that create/update documents in the **live** Foundry world (a GM must be
logged in). This skill is the bridge: read the notes, map them to document types,
and write them with the reliable tools.

## Preconditions (check first)

- The `foundry` MCP server is connected and its tools (`mcp__foundry__*`) are
  available. If not, the world isn't reachable — tell the user to start Foundry
  (GM logged in) with the module enabled and pointing at the same relay
  URL/token; don't guess.
- Writes hit the live world. For anything beyond a couple of documents, **show
  the user a plan first** (what will be created/updated, with names) and get a
  go-ahead before bulk-writing.

## What the tools already do for you

Every mutating tool runs the reliability pipeline (dry-run → write → read-back
verify → rollback on mismatch). You do **not** need to dry-run manually — just
call the tool and read its `steps`/`ok` in the result. A non-`ok` result carries
a structured `error.code` (`NOT_FOUND`, `VALIDATION`, `READBACK_MISMATCH`,
`AUTH`, `TIMEOUT`, …) — surface it, don't retry blindly.

## Note type → tool mapping

Adapt the paths to this repo's actual layout (see "Layout" below).

| Notes | Document | Tool |
| --- | --- | --- |
| NPCs / monsters | Actor | `create_document` (documentType `"Actor"`) |
| Player handouts / lore / session recaps | JournalEntry | `create_document` (`"JournalEntry"`) |
| Locations / battle maps | Scene | `create_scene` (high-level params) |
| Items / loot | Item | `create_document` (`"Item"`) |
| Random/loot tables | RollTable | `create_document` (`"RollTable"`) |
| Quests (Forien's Quest Log) | quest | `create_quest` |
| Tokens/lights/notes on a scene | embedded | `create_embedded` (parent = the Scene) |

## Workflow

1. **Locate** the source notes the user named (or the whole category). Use Glob/Grep.
2. **Parse** each note: front-matter for structured fields (name, type, system
   data), body for description. Name is required.
3. **Be idempotent.** Before creating, `find_documents` by name
   (`{ documentType, query: { name } }`). If it exists, prefer `update_document`
   on its `_id` (or ask whether to update vs. `duplicate_document`) so re-running
   doesn't pile up duplicates.
4. **Create/update** via the mapped tool. Keep `data` minimal and valid: always
   `name`; only add `system.*` fields you're confident the active game system
   accepts (e.g. dnd5e). When unsure of system schema, create the document with
   name + description and tell the user which fields you left out.
5. **Report** a concise table: each note → created/updated/skipped, with the new
   `_id` and any errors. Stop and ask if several writes fail the same way.

## Field tips

- Rich-text fields (e.g. JournalEntry pages, descriptions) take HTML. Convert
  markdown to simple HTML; don't dump raw markdown into a prose field.
- Scenes: prefer `create_scene`'s parameters (`name`, `width`, `height`,
  `gridSize`, `background`, …) over hand-building scene data.
- Quests aren't queryable via `find_documents`; you can't read them back, so you
  can't de-dupe quests by name — confirm with the user before re-creating.
- Deletes are destructive and not auto-allowed; always confirm before deleting.

## Layout (edit me)

Describe this repo's actual structure so future runs are unambiguous, e.g.:

```
npcs/*.md          → Actor       (front-matter: name, type, cr, system)
locations/*.md     → Scene       (front-matter: name, width, height, grid, background)
handouts/*.md      → JournalEntry
items/*.md         → Item
tables/*.md        → RollTable
quests/*.md        → quest
```
