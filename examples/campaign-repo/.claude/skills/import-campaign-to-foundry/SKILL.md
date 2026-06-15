---
name: import-campaign-to-foundry
description: Import this Curse of Strahd repo's notes (generated/ and journals/) into the running Foundry world via the foundry MCP tools, following the empty-id=create / filled-id=update upsert contract. Use when the user wants to "import", "push", "sync", or "create in Foundry" journals, NPCs/actors, or scenes — e.g. "import generated/journals into Foundry", "push the Lejren scene note", "sync the new NPCs".
---

# Import Curse of Strahd notes into Foundry (live MCP path)

This repo has **two** ways into Foundry:
- `scripts/import-*.js` — an **offline LevelDB** bridge (writes the world DB directly).
- the **foundry MCP tools** (`mcp__foundry__*`) — the **live** path, into a running
  world with a GM logged in. **This skill uses the live MCP path only.** Don't shell
  out to the LevelDB scripts unless the user explicitly asks.

## The upsert contract (authoritative)

Each note's front-matter `id` decides the operation:

- **`id: ""` (empty)** → `create_document`. On success, **write the returned `_id`
  back into the note's front-matter** so the next run updates instead of duplicating.
- **`id: "<16-char id>"` (filled)** → `update_document` with that `documentType`+`id`.

This is the plan §7.2 upsert pattern. The id round-trip is what keeps imports
idempotent — never skip writing the new id back.

## Classify by folder, not by title

| Path | documentType | Tool | Notes |
| --- | --- | --- | --- |
| `generated/journals/*.md` | `JournalEntry` | create/update_document | New hand-written GM notes (Danish). Titled "Scene: …" are still **journals** (roleplay/GM notes), not maps. |
| `journals/*.md` | `JournalEntry` | update_document | Extracted from Foundry; ids/folders are real. Usually already in the world → update. |
| `generated/npcs/*.md` | `Actor` | create/update_document | |
| `generated/scenes/*.md` | `Scene` | create_scene (new) / update_document (existing) | Actual maps/battle scenes. |
| `actors/npcs/*.json` | `Actor` | create_document data source | Full extracted actor JSON — usable as `data`. Read-only source; strip/ignore its `_id` when creating fresh, or treat as upsert. |
| `actors/`, `journals/` (extracted), `rules/` | — | — | Source/reference. **Read-only — never write back here.** |

## Front-matter

```yaml
id: ""                 # "" = create; 16-char id = update
name: "…"              # required; becomes the document name
folder: null           # null, or a real Foundry folder id (pass through on the document)
tags: [..]             # repo-side metadata; do NOT send as Foundry data
```

Map to tool input: `name` → `data.name`; `folder` (when a real id) → `data.folder`;
the markdown **body** → the document's prose field as **HTML** (convert markdown;
don't dump raw markdown). `tags` stay in the repo, not in Foundry.

## Workflow

1. **Scope** the files the user named (Glob, e.g. `generated/journals/*.md`).
2. For each note, parse front-matter + body and pick the tool from the table.
3. **Upsert:**
   - empty `id` → `create_document` (or `create_scene` for `generated/scenes/`);
     then edit the note's front-matter `id` to the returned `_id`.
   - filled `id` → `update_document` `{ documentType, id, data }`.
4. The tools run dry-run → write → read-back → rollback themselves; read each
   result's `ok`/`steps`. On a non-`ok` result, surface `error.code`
   (`NOT_FOUND` for a stale id, `VALIDATION`, `READBACK_MISMATCH`, `AUTH`,
   `TIMEOUT`) — don't blindly retry. A `NOT_FOUND` on a filled id means the doc
   was deleted in Foundry; ask whether to re-create (which mints a new id).
5. **Report** a table: note → created/updated/failed, new `_id`, error if any.

## Guardrails

- Writes hit the **live** world. For more than ~3 documents, show the plan
  (files, op, names) and get a go-ahead before bulk-writing.
- Confirm before any delete (deletes are terminal and not auto-allowed).
- Content in `generated/` is Danish; extracted `journals/` are often English —
  preserve each note's language; don't translate unless asked.
- If `mcp__foundry__*` tools aren't present, the world isn't reachable: tell the
  user to start Foundry (GM logged in, module enabled, matching relay URL/token).
  Don't fall back to the LevelDB scripts on your own.
