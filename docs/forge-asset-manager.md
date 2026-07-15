# The Forge VTT — Asset Manager Reference

> Discovery notes for the foundry-mcp-bridge. Captures what The Forge VTT exposes
> so contributors don't have to reverse-engineer it again. Companion to
> `docs/foundry-live-api-plan.md` §4 (A4 — The Forge asset upload).

## Browser-side globals (available inside the Foundry module)

These are available in the browser context where the Foundry module runs.

| Global | Type | Purpose |
|--------|------|---------|
| `ForgeVTT.usingTheForge` | `boolean` | `true` when the world is hosted on The Forge |
| `ForgeVTT.userId` | `string` | Forge user id (prefix for asset paths) |
| `ForgeVTT.APIKEY` | `string` | API key set in Foundry module settings |
| `ForgeVTT.GetAPIEndpoint(path)` | `(path: string) => string` | Builds `https://forge-vtt.com/api/{path}` |

Detect at runtime; never hardcode whether you're on The Forge:

```js
const onForge = Boolean(globalThis.ForgeVTT?.usingTheForge);
const source = onForge ? "forgevtt" : "data";
```

## FilePicker — the upload path (already wired)

`foundry-runtime.ts` already uploads via `FilePicker.upload`. The `source`
argument is `"data"` locally and `"forgevtt"` on The Forge; everything else is
identical, which is why the same code path works in both environments.

```js
await FilePicker.upload(source, targetDir, file, {});
// → { path: "worlds/test-mcp/images/scene.webp" }
```

## FilePicker.browse — listing assets

```js
const result = await FilePicker.browse(source, targetPath, options);
// result shape:
// {
//   target: "worlds/strahd/scenes",
//   dirs:  ["worlds/strahd/scenes/barovia", "worlds/strahd/scenes/castle"],
//   files: ["worlds/strahd/scenes/village.webp", "worlds/strahd/scenes/church.webp"],
//   gridSize: null,
//   extensions: [".webp", ".png", ".jpg"]
// }
```

Options: `{ extensions: [".webp", ".png"] }` filters the returned `files` by
extension. On The Forge, `source: "forgevtt"` lists assets from the Forge bucket.

## Direct REST API (Phase 2 — implemented)

The Forge also exposes a REST API callable from Node.js directly (no browser, no
running world, no relay round-trip). This is now wired into the MCP server as an
**optional** path alongside the relay tools — handy for *pre-flight* asset checks
(e.g. "does this map already exist?") before driving the live world.

```
Base URL: https://forge-vtt.com/api   (override with FORGE_API_BASE_URL)
(endpoint paths below are relative to Base URL — they are NOT re-prefixed with /api)

# Browse assets
POST {baseUrl}/assets/browse
Authorization: {FORGE_API_KEY}
Content-Type: application/json
Body: { path: "worlds/strahd/scenes" }
→ { dirs: [{ name, path }], files: [{ name, path, url, size }], folder, bazaar }
   (the client surfaces file `url`s and dir `name`s)

# Upload asset
POST {baseUrl}/assets/upload
Authorization: {FORGE_API_KEY}
Content-Type: multipart/form-data
Body: { path: "worlds/strahd/scenes/village.webp", file: <binary> }
   (path is the FULL destination — dir + filename, not a bare directory)
→ { success: true, path: "worlds/strahd/scenes/village.webp", url: "https://assets.forge-vtt.com/{userId}/worlds/strahd/scenes/village.webp" }

# Create folder
POST {baseUrl}/assets/new-folder
Authorization: {FORGE_API_KEY}
Content-Type: application/json
Body: { path: "worlds/strahd/tokens" }
→ { success: true }

# EU-region accounts: set FORGE_API_BASE_URL=https://eu.forge-vtt.com/api
```

### Server wiring

- **Config** (`config.ts`): set `FORGE_USER_ID` + `FORGE_API_KEY` (optionally
  `FORGE_API_BASE_URL`) in `.env`. All optional; when both id and key are present
  the server constructs a `ForgeRestClient` and enables the tools below.
- **Client** (`forge-rest.ts`): `ForgeRestClient` performs the calls above with
  an injectable `fetch` (so tests never hit the network), a per-request timeout
  via `AbortController`, and structured `ForgeRestError`s on non-2xx / non-JSON.
- **Tools** (`forge-tools.ts`, registered in `server.ts`): bypass the relay and
  return the same `ToolOutcome` shape as the relay tools.

  | Tool | Maps to | Result |
  |------|---------|--------|
  | `forge_browse_assets` | `GET .../assets?path=` | `{ files, dirs }` |
  | `forge_upload_asset` | `POST .../assets/upload` | `{ path }` |
  | `forge_batch_upload_assets` | pre-browse + N× `POST .../assets/upload` | `[{ filename, path, skipped? }]` |
  | `forge_create_folder` | `PUT .../assets` | `{ success }` |

  `forge_batch_upload_assets` mirrors the relay `batch_upload_assets`: up to 50
  files per call, and `skipExisting` dedups by **basename** (so Forge's absolute
  CDN URLs compare correctly). A skipped entry reports the asset's real existing
  path; an in-batch duplicate reports the first uploaded path. Files upload
  sequentially so the in-batch dedup sees earlier uploads.

  When the credentials aren't configured the tools return a structured
  `UNSUPPORTED` error naming the env keys, rather than silently doing nothing.
  HTTP `404 → NOT_FOUND`, `401/403 → AUTH`, everything else `→ INTERNAL`.

These tools do **not** go through the relay reliability pipeline (no dry-run /
read-back), because they don't touch live Foundry documents — the Forge API's
returned path/flag is the confirmation. Live verification against a real Forge
account is the only remaining step (a `FORGE_API_KEY` is required to exercise it).
