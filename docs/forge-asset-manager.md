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

## Direct REST API (Phase 2 — requires Node.js + API key)

The Forge also exposes a REST API callable from Node.js directly (no browser
required). This is **NOT** used today — every asset operation currently goes
through the browser relay (`FilePicker`). Documented here so a future tool can
call it without re-discovering it.

```
Base URL: https://forge-vtt.com/api

# Browse assets
GET /api/user/{userId}/assets?path={path}
Authorization: {FORGE_API_KEY}
→ { files: [...], dirs: [...] }

# Upload asset
POST /api/assets/upload
Authorization: {FORGE_API_KEY}
Content-Type: multipart/form-data
Body: { target: "worlds/strahd/scenes", file: <binary> }
→ { path: "worlds/strahd/scenes/village.webp" }

# Create folder
PUT /api/user/{userId}/assets
Authorization: {FORGE_API_KEY}
Body: { path: "worlds/strahd/tokens" }
→ { success: true }
```

Calling these from the MCP server would require `FORGE_USER_ID` + `FORGE_API_KEY`
in `.env`. Useful for pre-flight asset checks without a browser round-trip.
**Out of scope for the current plan** — flagged as Phase 2.
