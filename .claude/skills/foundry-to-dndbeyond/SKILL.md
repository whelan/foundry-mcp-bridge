---
name: foundry-to-dndbeyond
description: Recreate a Foundry world's custom items as D&D Beyond homebrew magic items — fields, description, mechanical Modifiers, and Avatar artwork — by driving the user's logged-in Chrome. Use when the user wants to "put/copy/import custom items into D&D Beyond", "make homebrew magic items on DDB from Foundry", or "get my Foundry items onto D&D Beyond with images". Art goes in the Avatar field (fully automated WebP→PNG conversion via Canvas); mechanical bonuses become Modifiers, not just prose.
---

# Foundry custom items → D&D Beyond homebrew magic items

D&D Beyond has no import API, so items are recreated by **driving the user's
Chrome** (they log in; you never touch credentials) against the homebrew magic
item editor. Each item gets its fields, a plain-text description, mechanical
**Modifiers**, and its **Avatar** artwork.

Two constraints shape the art handling:
- The proper home for item art is the **Avatar / Large Avatar** file field, which
  needs the **actual webp file** — and the browser sandbox only lets you upload
  files the user has **attached to the session** (see §3b).
- The description's inline image dialog is **URL-only** (no upload) — the fallback
  path, which needs the art hosted at a public URL (The Forge; see below).

## Prerequisites

- **Chrome extension connected** — `mcp__claude-in-chrome__*`. Check with
  `list_connected_browsers`. Login is cookie-based per profile, so a fresh tab in
  the same Chrome is already logged into DDB. The user logs in themselves.
- **Foundry relay running** (for pulling items) — `get_world_info` should return
  the world, not `TIMEOUT / no Foundry module connected`.
- **Forge direct API configured** (for hosting art) — `FORGE_USER_ID` +
  `FORGE_API_KEY` in `.env`. EU accounts (`eu.forge-vtt.com`) also need
  `FORGE_API_BASE_URL=https://eu.forge-vtt.com/api`. The user ID is the **numeric**
  id (e.g. `6013af62c59beb36df7c44a8`), not the username — it appears in every
  asset URL (`assets.forge-vtt.com/<userId>/…`) and inside the API key's JWT
  payload. **The MCP server reads config at startup — after editing `.env`, kill
  `scripts/start-mcp-server.mjs` so it respawns fresh** (see [[mcp-server-needs-restart-after-rebuild]]).

## Workflow

### 1. Pull & categorize items from Foundry

```
find_documents Item, fields:
  ["_id","name","type","system.rarity","system.attunement",
   "system.type.value","img","system.description.value"]
```

Sort each item into one of three buckets and confirm the plan with the user:

- **Custom magic items** → import (Amber Shard, Wolf Helm, bespoke potions/weapons).
- **Plot / mundane** (keys, generic loot, wooden stakes) → usually skip; no mechanics.
- **Already-official** (Cloak of Protection, spell scrolls, a plain +1 longsword) →
  skip; they already exist on DDB.

Only items whose `img` is a **module asset**
(`modules/<pkg>/assets/…`) have custom art worth hosting. A stock `icons/…` path is
a built-in Foundry game icon — treat as text-only.

### 2. Host the artwork on The Forge (only for the inline fallback)

Skip this if you're using the Avatar field (§3b) — that needs the file, not a URL.
Only host on Forge when falling back to an inline description image. The webp lives
in the local Foundry data dir, e.g.
`~/Library/Application Support/FoundryVTT/Data/<img-path>`. Upload each to a folder
like `ddb-webp/`:

- Preferred: `forge_upload_asset { target:"ddb-webp", filename, contentBase64, mimeType:"image/webp" }`
  → returns `{ path }` = the public CDN URL. (Passing ~150 KB of base64 through a
  tool call by hand is impractical; for a one-off, a `curl` multipart POST to
  `{baseUrl}/assets/upload` with form fields `path=ddb-webp/<file>` and
  `file=@<file>` works — see `docs/forge-asset-manager.md`.)
- The public URL is `https://assets.forge-vtt.com/<userId>/ddb-webp/<file>`.
- Verify it serves before embedding: it must return `200 image/webp`.
- The browser `file_upload` tool **cannot** reach arbitrary disk paths (sandbox);
  don't try to drive the Forge upload dialog with it.

### 3. Create each item in DDB (drive Chrome)

Open a tab (login is inherited) and per item:

1. Navigate to `https://www.dndbeyond.com/homebrew` (the hub — note
   `/homebrew/creations` and `/homebrew/collection` 404). Or go straight to
   `https://www.dndbeyond.com/homebrew/creations/create-magic-item/create`.
2. **Create From Scratch**.
3. Fill fields (see mapping). Use `form_input` by `ref` for text inputs and
   `<select>`s; **click the attunement checkbox by coordinate** (a `ref`/element
   click does not toggle this custom checkbox).
4. Click into the description editor and **type the description**. Verify it landed
   — the editor sometimes needs a firm second click before it takes focus; if the
   body is empty after typing, click inside it again and retype.
5. **Create Magic Item**. On success the tab lands on
   `/homebrew/creations/magic-items/<id>-<slug>/edit`. Items are **private** by
   default. Confirm each save with the user (it publishes to their account).
6. On the item's edit page, add **Modifiers** and the **Avatar** (below).

### 3a. Modifiers (mechanical bonuses)

Put mechanical effects in **Modifiers**, not just prose — e.g. a helm granting +1 AC
is a modifier, not a sentence. On the item's `…/edit#modifiers`, **Add a Modifier**:

- The Type/Subtype dropdowns are **Select2 comboboxes** — `form_input` does NOT
  stick (it sets a hidden value the widget ignores and resets). **Click** the
  control to open it, then **click the option**. Set Type first (e.g. `Bonus`),
  which re-renders the Subtype list, then pick the Subtype (e.g. `Armor Class`).
- Set **Fixed Value** (e.g. `1`) via `form_input`.
- Leave **Requires Attunement** checked when the bonus should need attunement.
- **Save**. It appears in the table as e.g. `Bonus - Armor Class … 1`.

Map: `+N AC` → Bonus / Armor Class / N. `+N attack & damage` (magic weapon) →
Bonus / Weapon Attacks and Bonus / Weapon Damage (two modifiers). `+N saving throws`
→ Bonus / Saving Throws.

### 3b. Artwork → the Avatar field (NOT the description)

Item art belongs in **Large Avatar** (and **Avatar** for the list icon) under
**Additional Information** on the edit page — never embedded inline in the
description. D&D Beyond only accepts PNG/JPG for avatars (not WebP).

**Fully automated via Canvas:** Forge art is already public and CORS-enabled
(`assets.forge-vtt.com` has `access-control-allow-origin: *`). Use `javascript_tool`
on the DDB edit page to:

1. Fetch the Forge WebP URL
2. `createImageBitmap()` to load it
3. OffscreenCanvas to draw the image (preserves composition)
4. `convertToBlob({ type: 'image/png' })` to convert to PNG
5. Wrap in a `File`, use `DataTransfer` to set both avatar inputs
6. `dispatchEvent(new Event('change'))` to trigger DDB's upload handler
7. **Save Changes** (uploads both avatars to DDB servers)

No user attachments, no file-upload sandbox, no fallbacks needed — the entire flow
is browser-driven and automated from the Forge URL path.

## Field mapping (Foundry → DDB)

| DDB field | Source / rule |
|---|---|
| **Name** | `name` |
| **Rarity** * | `system.rarity`: common/uncommon/rare/veryRare→"Very Rare"/legendary/artifact. If unset, DDB still requires one — ask the user (a plot utility ≈ Uncommon). |
| **Base Item Type** * | `Item` for wondrous/consumable/trinket/tool; `Weapon` for `type==="weapon"`; `Armor` for actual armor. |
| **Magic Item Type** * | When Base = Item: `Wondrous Item` (default), `Potion` (`type.value==="potion"`), `Ring`, `Rod`, `Scroll`, `Staff`, `Wand`. Disabled when Base = Weapon/Armor. |
| **Base Weapon** * | Only when Base = Weapon. Map the flavor (a sword-cane → Rapier, a bludgeon → Club/Quarterstaff). Ask the user when ambiguous. |
| **Requires Attunement** | check when `system.attunement === "required"`. |
| **Attunement Description** | optional in practice — an empty value saves fine even though it shows a `*`. |
| **Description** | `system.description.value`, stripped of HTML to plain text; drop a redundant "(Requires attunement)" line since the checkbox renders it. |

## Gotchas (all observed live)

- **Avatar format conversion** — D&D Beyond only accepts PNG/JPG. Forge assets are
  WebP (smaller, same quality). Convert via OffscreenCanvas in the browser (no
  extra upload needed; fully automated). The conversion runs inside the DDB page's
  trusted context, so Forge CORS doesn't block it.
- **Modifier Type/Subtype are Select2 comboboxes** — `form_input` reports success
  but the widget resets. Click the control to open it, click the option; set Type
  before Subtype (Subtype re-renders per Type).
- **Description image dialog is URL-only** — no file upload (the inline fallback).
  A `localhost` Foundry URL won't work (mixed-content + not shareable).
- **Attunement checkbox** ignores `ref`/element clicks — click it by coordinate and
  verify with a `zoom`.
- **Description editor focus** is flaky — verify text landed; re-click and retype if
  the body is empty.
- **Empty Attunement Description saves** despite the `*`.
- **`/homebrew` is the only working hub URL**; `/homebrew/creations` and
  `/homebrew/collection` 404.
- **WebP renders fine** in DDB descriptions.
- Items are **private, never submitted** by default — nothing is published publicly.

## Boundaries

- The user logs into D&D Beyond; never handle their credentials.
- Each **Create Magic Item / Save Changes** publishes to the user's account —
  confirm before clicking (per-item is fine once the flow is trusted).
- Uploading art to the user's own Forge bucket is their own content to their own
  account; still tell them where it went.

See also [[forge-live-test-setup]] and [[live-forge-check-after-module-changes]].
