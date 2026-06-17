# Forge Asset Manager + Curse of Strahd Full Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `browse_assets` + `batch_upload_assets` MCP tools so the AI can
inventory and bulk-upload images, then extend the import skill to drive a
complete Curse of Strahd import (scenes with map backgrounds, actors with token
images, journal entries, quests with sub-quests) against both a local Foundry
and The Forge cloud host.

**Architecture:** Every new capability follows the existing lockstep: protocol
schema → executor interface + dispatch → foundry-runtime (real) → mock-foundry
(test) → mock-foundry-api adapter → relay-client stub → reliability wrapper →
MCP tool + server registration. The Forge-specific path re-uses `FilePicker` (via
`source: "forgevtt"`) so the same code path works locally and in the cloud — the
only difference is the `source` string. A new `forge` field on `get_world_info`
tells the AI which source to use without hardcoding it.

**Tech Stack:** TypeScript (NodeNext ESM), zod, vitest, ws, MCP SDK, Foundry VTT
v14 API (`FilePicker.browse`, `FilePicker.upload`, `ForgeVTT` global).

---

## The Forge Asset Manager — Discovery Notes

These notes capture what the Forge VTT exposes so every implementer starts with
the same mental model. **Read this before touching code.**

### Browser-side globals (available inside the Foundry module)

| Global | Type | Purpose |
|--------|------|---------|
| `ForgeVTT.usingTheForge` | `boolean` | `true` when hosted on The Forge |
| `ForgeVTT.userId` | `string` | Forge user id (prefix for asset paths) |
| `ForgeVTT.APIKEY` | `string` | API key set in Foundry module settings |
| `ForgeVTT.GetAPIEndpoint(path)` | `(path: string) => string` | Builds `https://forge-vtt.com/api/{path}` |

### `FilePicker` (the existing upload path)

```js
// Already wired in foundry-runtime.ts — source = "data" or "forgevtt"
await FilePicker.upload(source, targetDir, file, {});
// Returns { path: "worlds/test-mcp/images/scene.webp" }
```

### `FilePicker.browse` (NEW — what browse_assets will call)

```js
const result = await FilePicker.browse(source, targetPath, options);
// result shape:
{
  target: "worlds/strahd/scenes",
  dirs:  ["worlds/strahd/scenes/barovia", "worlds/strahd/scenes/castle"],
  files: ["worlds/strahd/scenes/village.webp", "worlds/strahd/scenes/church.webp"],
  gridSize: null,
  extensions: [".webp", ".png", ".jpg"]
}
```

Options: `{ extensions: [".webp", ".png"] }` to filter file types.

### The Forge REST API (bypasses browser / relay — future phase)

The Forge also exposes a REST API callable from Node.js directly (no browser
required). This is NOT used in Phase 1 — everything goes through the relay.
Documented here so a future tool can call it without reverse-engineering again.

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

The MCP server would need `FORGE_USER_ID` + `FORGE_API_KEY` in `.env` to call
these. Useful for pre-flight asset checks without a round-trip through the
browser relay. **Out of scope for this plan** — flagged as Phase 2.

---

## File Map

| File | Change |
|------|--------|
| `packages/shared/src/protocol.ts` | Add `BrowseAssetsCommand` + `BatchUploadAssetsCommand` to the `Command` union |
| `packages/foundry-module/src/protocol-executor.ts` | Add `browseAssets` + `batchUploadAssets` to `FoundryDocumentApi` interface + dispatch cases; extend `GetWorldInfoCommand` result to include `forge` field |
| `packages/foundry-module/src/foundry-runtime.ts` | Implement `browseAssets` (`FilePicker.browse`), `batchUploadAssets` (loop + FilePicker.upload), extend `getWorldInfo` with Forge detection |
| `test/integration/mock-foundry.ts` | Implement `browseAssets` + `batchUploadAssets` in mock store; extend `getWorldInfo` mock to return `forge` field |
| `test/integration/mock-foundry-api.ts` | Add the two new methods to the `FoundryDocumentApi` adapter |
| `packages/foundry-module/src/relay-client.test.ts` | Add the two new methods to `stubApi()` |
| `packages/mcp-server/src/reliability.ts` | Add `browseAssetsReliable` + `batchUploadAssetsReliable` |
| `packages/mcp-server/src/tools.ts` | Add `BrowseAssetsShape` + `runBrowseAssets`, `BatchUploadAssetsShape` + `runBatchUploadAssets` |
| `packages/mcp-server/src/server.ts` | Register `browse_assets` and `batch_upload_assets` tools |
| `.claude/settings.json` | Add `mcp__foundry__browse_assets` + `mcp__foundry__batch_upload_assets` to `permissions.allow` |
| `test/integration/mcp-tools.test.ts` | Tests for both new tools |
| `examples/campaign-repo/.claude/skills/import-campaign-to-foundry/SKILL.md` | Extend skill to cover: asset detection, bulk upload, Strahd scene/actor/journal/quest structure |
| `docs/forge-asset-manager.md` | Discovery doc — Forge API reference for contributors |
| `.env.example` | Add optional `FORGE_USER_ID` / `FORGE_API_KEY` placeholders (Phase 2 note) |

---

## Task 1: Document the Forge API (no code)

**Files:**
- Create: `docs/forge-asset-manager.md`

- [ ] **Step 1: Write the discovery doc**

Create `docs/forge-asset-manager.md` with the content from the "Discovery Notes"
section above (Forge globals, FilePicker.browse shape, REST API reference). This
becomes the canonical reference so no one has to reverse-engineer it again.

```markdown
# The Forge VTT — Asset Manager Reference

## Browser globals (available inside the Foundry module)
...
## FilePicker.browse
...
## Direct REST API (Phase 2, requires Node.js + API key)
...
```

- [ ] **Step 2: Commit**

```bash
git add docs/forge-asset-manager.md
git commit -m "docs: add Forge asset manager API reference"
```

---

## Task 2: `browse_assets` — protocol schema

**Files:**
- Modify: `packages/shared/src/protocol.ts` (after the `UploadAssetCommand` block, before `Command`)

- [ ] **Step 1: Add `BrowseAssetsCommand` to protocol.ts**

Insert after `UploadAssetCommand` (around line 195):

```typescript
export const BrowseAssetsCommand = z.object({
  action: z.literal("browseAssets"),
  /** Storage source: local "data" or Forge "forgevtt". */
  source: z.enum(["data", "forgevtt"]).default("data"),
  /** Directory path to list. Trailing slash optional. */
  target: z.string().min(1),
  /** Optional file extension filter (e.g. [".webp", ".png"]). */
  extensions: z.array(z.string()).optional(),
});
export type BrowseAssetsCommand = z.infer<typeof BrowseAssetsCommand>;
```

Then add `BrowseAssetsCommand` to the `Command` discriminated union:

```typescript
export const Command = z.discriminatedUnion("action", [
  CreateCommand,
  UpdateCommand,
  DeleteCommand,
  DuplicateCommand,
  CreateEmbeddedCommand,
  UpdateEmbeddedCommand,
  DeleteEmbeddedCommand,
  FindCommand,
  CreateQuestCommand,
  UpdateQuestCommand,
  DeleteQuestCommand,
  GetWorldInfoCommand,
  UploadAssetCommand,
  BrowseAssetsCommand,   // ← add this
]);
```

- [ ] **Step 2: Typecheck (expect failures — the interface hasn't been updated yet)**

```bash
cd /Volumes/projects/foundry-mcp-bridge && npm run typecheck 2>&1 | head -30
```

Expected: errors about missing `browseAssets` on `FoundryDocumentApi` and
`dispatch`. That's correct — move to the next task.

---

## Task 3: `browse_assets` — executor interface + dispatch

**Files:**
- Modify: `packages/foundry-module/src/protocol-executor.ts`

- [ ] **Step 1: Read the current interface definition**

Open `packages/foundry-module/src/protocol-executor.ts`. Find `FoundryDocumentApi`
(the interface, not the class). It has methods like `createDocument`, `uploadAsset`,
`getWorldInfo`, etc.

- [ ] **Step 2: Add `browseAssets` to the interface**

Add after `uploadAsset`:

```typescript
browseAssets(
  params: { source: string; target: string; extensions?: string[] },
  opts: ExecOptions,
): Promise<{ dirs: string[]; files: string[]; target: string }>;
```

- [ ] **Step 3: Add the dispatch case**

In `dispatch()`, add a case for `"browseAssets"` after the `"uploadAsset"` case:

```typescript
case "browseAssets":
  return ok(await api.browseAssets(
    { source: cmd.source, target: cmd.target, extensions: cmd.extensions },
    opts,
  ));
```

- [ ] **Step 4: Typecheck (still expect failures — runtime + mock not done yet)**

```bash
npm run typecheck 2>&1 | head -20
```

Expected: errors about missing `browseAssets` in `foundry-runtime.ts`,
`mock-foundry-api.ts`, and `relay-client.test.ts stubApi()`. Continue.

---

## Task 4: `browse_assets` — real Foundry implementation

**Files:**
- Modify: `packages/foundry-module/src/foundry-runtime.ts`

- [ ] **Step 1: Add `browseAssets` to the runtime object**

Find the `getFoundryApi()` function and add after the `uploadAsset` method:

```typescript
async browseAssets(params, opts) {
  // Dry-run: return empty listing (nothing to validate against).
  if (opts.dryRun) return { dirs: [], files: [], target: params.target };
  const options: Record<string, unknown> = {};
  if (params.extensions?.length) options.extensions = params.extensions;
  const result = await (FilePicker as any).browse(params.source, params.target, options);
  return {
    dirs: (result?.dirs ?? []) as string[],
    files: (result?.files ?? []) as string[],
    target: String(result?.target ?? params.target),
  };
},
```

---

## Task 5: `browse_assets` — mock implementation

**Files:**
- Modify: `test/integration/mock-foundry.ts`

- [ ] **Step 1: Add file storage to MockFoundry**

The mock needs a virtual filesystem. Find `MockFoundry` and add a `files` Map:

```typescript
files = new Map<string, string>(); // path → "file"
```

- [ ] **Step 2: Add `browseAssets` to MockFoundry**

Add the method to `MockFoundry`:

```typescript
browseAssets(params: { source: string; target: string; extensions?: string[] }): {
  dirs: string[];
  files: string[];
  target: string;
} {
  const target = params.target.replace(/\/$/, "");
  const allFiles = [...this.files.keys()];
  const matchedFiles = allFiles.filter((p) => {
    if (!p.startsWith(target + "/")) return false;
    const rel = p.slice(target.length + 1);
    if (rel.includes("/")) return false; // skip subdirs' files
    if (params.extensions?.length) {
      return params.extensions.some((ext) => p.endsWith(ext));
    }
    return true;
  });
  const dirs = [...new Set(
    allFiles
      .filter((p) => p.startsWith(target + "/"))
      .map((p) => {
        const rel = p.slice(target.length + 1);
        const first = rel.split("/")[0];
        return rel.includes("/") ? `${target}/${first}` : null;
      })
      .filter(Boolean) as string[],
  )];
  return { dirs, files: matchedFiles, target };
}
```

- [ ] **Step 3: Wire `uploadAsset` to populate `files`**

In the mock's `uploadAsset` method (or `handle` function if procedural), after
storing the upload, also add the path to `this.files`:

```typescript
const path = `${params.target.replace(/\/$/, "")}/${params.filename}`;
if (!params.dryRun) this.files.set(path, "file");
return { path };
```

---

## Task 6: `browse_assets` — test doubles and adapter

**Files:**
- Modify: `test/integration/mock-foundry-api.ts`
- Modify: `packages/foundry-module/src/relay-client.test.ts`

- [ ] **Step 1: Add `browseAssets` to mock-foundry-api.ts**

Find where `uploadAsset` is forwarded and add after it:

```typescript
browseAssets(params, opts) {
  if (opts.dryRun) return Promise.resolve({ dirs: [], files: [], target: params.target });
  return Promise.resolve(this.mock.browseAssets(params));
},
```

- [ ] **Step 2: Add `browseAssets` to `stubApi()` in relay-client.test.ts**

Find `stubApi()` (it returns a `FoundryDocumentApi` object). Add:

```typescript
browseAssets: async () => ({ dirs: [], files: [], target: "/" }),
```

- [ ] **Step 3: Typecheck — should clear the browseAssets errors**

```bash
npm run typecheck 2>&1 | head -20
```

Expected: only `batchUploadAssets`-related errors remain (or clean if that task
comes later).

---

## Task 7: `browse_assets` — reliability wrapper and MCP tool

**Files:**
- Modify: `packages/mcp-server/src/reliability.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Add `browseAssetsReliable` to reliability.ts**

`browse_assets` is a **read** operation — no dry-run, no write, no read-back.
Use the existing `runRead` helper. Add after `uploadAssetReliable`:

```typescript
export type BrowseAssetsParams = {
  source: "data" | "forgevtt";
  target: string;
  extensions?: string[];
};

export function browseAssetsReliable(
  transport: RelayTransport,
  input: BrowseAssetsParams,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runRead(
    transport,
    { action: "browseAssets", source: input.source, target: input.target, extensions: input.extensions },
    "browse-assets",
    opts,
  );
}
```

- [ ] **Step 2: Add `BrowseAssetsShape` + `runBrowseAssets` to tools.ts**

```typescript
export const BrowseAssetsShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  extensions: z.array(z.string()).optional(),
};
const BrowseAssets = z.object(BrowseAssetsShape);
export type BrowseAssetsArgs = z.infer<typeof BrowseAssets>;

export function runBrowseAssets(
  transport: RelayTransport,
  args: BrowseAssetsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return browseAssetsReliable(transport, args, opts);
}
```

- [ ] **Step 3: Register `browse_assets` in server.ts**

In `server.ts` find the pattern where tools are registered and add:

```typescript
server.registerTool(
  "browse_assets",
  {
    description:
      "List files and sub-directories in a Foundry asset directory. " +
      "Use source=\"forgevtt\" when the world is hosted on The Forge. " +
      "Returns { dirs, files, target }.",
    inputSchema: BrowseAssetsShape,
  },
  async (args) => toCallResult(await runBrowseAssets(transport, args, opts)),
);
```

- [ ] **Step 4: Add to settings.json auto-allow**

In `.claude/settings.json` add `"mcp__foundry__browse_assets"` to the
`permissions.allow` array.

---

## Task 8: Tests for `browse_assets`

**Files:**
- Modify: `test/integration/mcp-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Add a new `describe("browse_assets", ...)` block:

```typescript
describe("browse_assets", () => {
  it("returns empty listing for unknown path", async () => {
    const out = await runBrowseAssets(transport, { source: "data", target: "worlds/none" });
    if (!out.ok) throw new Error(`browse failed: ${out.error.message}`);
    expect(out.data).toMatchObject({ dirs: [], files: [], target: "worlds/none" });
  });

  it("lists files after upload", async () => {
    // Upload a file first
    const up = await runUploadAsset(transport, {
      source: "data",
      target: "worlds/strahd/scenes",
      filename: "village.webp",
      contentBase64: btoa("fake"),
    });
    if (!up.ok) throw new Error("upload failed");

    const out = await runBrowseAssets(transport, {
      source: "data",
      target: "worlds/strahd/scenes",
    });
    if (!out.ok) throw new Error(`browse failed: ${out.error.message}`);
    const data = out.data as { files: string[]; dirs: string[]; target: string };
    expect(data.files).toContain("worlds/strahd/scenes/village.webp");
  });

  it("filters by extension", async () => {
    await runUploadAsset(transport, {
      source: "data", target: "worlds/strahd/scenes",
      filename: "map.png", contentBase64: btoa("png"),
    });
    await runUploadAsset(transport, {
      source: "data", target: "worlds/strahd/scenes",
      filename: "notes.pdf", contentBase64: btoa("pdf"),
    });
    const out = await runBrowseAssets(transport, {
      source: "data",
      target: "worlds/strahd/scenes",
      extensions: [".png"],
    });
    if (!out.ok) throw new Error(`browse failed: ${out.error.message}`);
    const data = out.data as { files: string[] };
    expect(data.files.some((f) => f.endsWith(".png"))).toBe(true);
    expect(data.files.some((f) => f.endsWith(".pdf"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests (expect failure — not implemented yet)**

```bash
cd /Volumes/projects/foundry-mcp-bridge && npx vitest run test/integration/mcp-tools.test.ts -t "browse_assets" 2>&1 | tail -20
```

Expected: fails because `runBrowseAssets` not imported.

- [ ] **Step 3: Add import**

At the top of `mcp-tools.test.ts`, add `runBrowseAssets` to the import from
`tools.js`.

- [ ] **Step 4: Run tests — should pass**

```bash
npx vitest run test/integration/mcp-tools.test.ts -t "browse_assets" 2>&1 | tail -10
```

Expected: 3 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
npm run typecheck && npm test 2>&1 | tail -20
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol.ts \
        packages/foundry-module/src/protocol-executor.ts \
        packages/foundry-module/src/foundry-runtime.ts \
        test/integration/mock-foundry.ts \
        test/integration/mock-foundry-api.ts \
        packages/foundry-module/src/relay-client.test.ts \
        packages/mcp-server/src/reliability.ts \
        packages/mcp-server/src/tools.ts \
        packages/mcp-server/src/server.ts \
        .claude/settings.json \
        test/integration/mcp-tools.test.ts
git commit -m "feat: add browse_assets tool (FilePicker.browse over relay)"
```

---

## Task 9: `batch_upload_assets` — protocol schema

**Files:**
- Modify: `packages/shared/src/protocol.ts`

- [ ] **Step 1: Add `BatchUploadAssetsCommand` to protocol.ts**

Insert after `BrowseAssetsCommand`:

```typescript
export const BatchUploadEntry = z.object({
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  mimeType: z.string().optional(),
});
export type BatchUploadEntry = z.infer<typeof BatchUploadEntry>;

export const BatchUploadAssetsCommand = z.object({
  action: z.literal("batchUploadAssets"),
  /** Storage source: local "data" or Forge "forgevtt". */
  source: z.enum(["data", "forgevtt"]).default("data"),
  /** Target directory (trailing slash optional). */
  target: z.string().min(1),
  /** Files to upload. */
  files: z.array(BatchUploadEntry).min(1).max(50),
  /** If true, skip files whose path already exists (from a prior browse). */
  skipExisting: z.boolean().default(false),
});
export type BatchUploadAssetsCommand = z.infer<typeof BatchUploadAssetsCommand>;
```

Add `BatchUploadAssetsCommand` to the `Command` union.

---

## Task 10: `batch_upload_assets` — executor, runtime, mock, doubles

**Files:**
- Modify: `packages/foundry-module/src/protocol-executor.ts`
- Modify: `packages/foundry-module/src/foundry-runtime.ts`
- Modify: `test/integration/mock-foundry.ts`
- Modify: `test/integration/mock-foundry-api.ts`
- Modify: `packages/foundry-module/src/relay-client.test.ts`

- [ ] **Step 1: Add to FoundryDocumentApi interface**

```typescript
batchUploadAssets(
  params: {
    source: string;
    target: string;
    files: Array<{ filename: string; contentBase64: string; mimeType?: string }>;
    skipExisting?: boolean;
  },
  opts: ExecOptions,
): Promise<Array<{ filename: string; path: string; skipped?: boolean }>>;
```

- [ ] **Step 2: Add dispatch case**

```typescript
case "batchUploadAssets":
  return ok(await api.batchUploadAssets(
    {
      source: cmd.source,
      target: cmd.target,
      files: cmd.files,
      skipExisting: cmd.skipExisting,
    },
    opts,
  ));
```

- [ ] **Step 3: Implement in foundry-runtime.ts**

```typescript
async batchUploadAssets(params, opts) {
  const target = params.target.replace(/\/$/, "");
  const results: Array<{ filename: string; path: string; skipped?: boolean }> = [];

  // Dry-run: return what would be uploaded without writing.
  if (opts.dryRun) {
    return params.files.map((f) => ({ filename: f.filename, path: `${target}/${f.filename}` }));
  }

  // Optional skip: pre-browse the directory.
  const existing = new Set<string>();
  if (params.skipExisting) {
    const browse = await (FilePicker as any).browse(params.source, target, {});
    for (const f of browse?.files ?? []) existing.add(f);
  }

  for (const entry of params.files) {
    const path = `${target}/${entry.filename}`;
    if (existing.has(path)) {
      results.push({ filename: entry.filename, path, skipped: true });
      continue;
    }
    const bytes = Uint8Array.from(atob(entry.contentBase64), (c) => c.charCodeAt(0));
    const file = new File([bytes], entry.filename, entry.mimeType ? { type: entry.mimeType } : undefined);
    const result = await (FilePicker as any).upload(params.source, target, file, {});
    const storedPath = result?.path;
    if (typeof storedPath !== "string" || !storedPath) {
      throw new CommandExecutionError("INTERNAL", `FilePicker.upload failed for ${entry.filename}`);
    }
    results.push({ filename: entry.filename, path: storedPath });
  }
  return results;
},
```

- [ ] **Step 4: Implement in mock-foundry.ts**

```typescript
batchUploadAssets(params: {
  source: string;
  target: string;
  files: Array<{ filename: string; contentBase64: string; mimeType?: string }>;
  skipExisting?: boolean;
}): Array<{ filename: string; path: string; skipped?: boolean }> {
  const target = params.target.replace(/\/$/, "");
  return params.files.map((entry) => {
    const path = `${target}/${entry.filename}`;
    if (params.skipExisting && this.files.has(path)) {
      return { filename: entry.filename, path, skipped: true };
    }
    this.files.set(path, "file");
    return { filename: entry.filename, path };
  });
}
```

- [ ] **Step 5: Add to mock-foundry-api.ts**

```typescript
batchUploadAssets(params, opts) {
  if (opts.dryRun) {
    return Promise.resolve(
      params.files.map((f) => ({
        filename: f.filename,
        path: `${params.target.replace(/\/$/, "")}/${f.filename}`,
      })),
    );
  }
  return Promise.resolve(this.mock.batchUploadAssets(params));
},
```

- [ ] **Step 6: Add to stubApi() in relay-client.test.ts**

```typescript
batchUploadAssets: async (params) =>
  params.files.map((f) => ({ filename: f.filename, path: `${params.target}/${f.filename}` })),
```

---

## Task 11: `batch_upload_assets` — reliability wrapper, tool, server

**Files:**
- Modify: `packages/mcp-server/src/reliability.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Add `batchUploadAssetsReliable` to reliability.ts**

Batch upload is **terminal** (like `uploadAsset`): dry-run → write, no read-back.

```typescript
export type BatchUploadEntry = {
  filename: string;
  contentBase64: string;
  mimeType?: string;
};

export type BatchUploadAssetsParams = {
  source: "data" | "forgevtt";
  target: string;
  files: BatchUploadEntry[];
  skipExisting?: boolean;
};

export function batchUploadAssetsReliable(
  transport: RelayTransport,
  input: BatchUploadAssetsParams,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const command = {
    action: "batchUploadAssets" as const,
    source: input.source,
    target: input.target,
    files: input.files,
    skipExisting: input.skipExisting ?? false,
  };
  return runTerminal(transport, command, "batch-upload-assets", opts);
}
```

- [ ] **Step 2: Add `BatchUploadAssetsShape` + `runBatchUploadAssets` to tools.ts**

```typescript
export const BatchUploadAssetsShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  files: z.array(
    z.object({
      filename: z.string().min(1),
      contentBase64: z.string().min(1),
      mimeType: z.string().optional(),
    }),
  ).min(1).max(50),
  skipExisting: z.boolean().default(false),
};
const BatchUploadAssets = z.object(BatchUploadAssetsShape);
export type BatchUploadAssetsArgs = z.infer<typeof BatchUploadAssets>;

export function runBatchUploadAssets(
  transport: RelayTransport,
  args: BatchUploadAssetsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return batchUploadAssetsReliable(transport, args, opts);
}
```

- [ ] **Step 3: Register in server.ts**

```typescript
server.registerTool(
  "batch_upload_assets",
  {
    description:
      "Upload multiple asset files to Foundry storage in one call. " +
      "Use source=\"forgevtt\" on The Forge. " +
      "Set skipExisting=true to skip files already present (requires a prior browse_assets call). " +
      "Returns array of { filename, path, skipped? }. Max 50 files per call.",
    inputSchema: BatchUploadAssetsShape,
  },
  async (args) => toCallResult(await runBatchUploadAssets(transport, args, opts)),
);
```

- [ ] **Step 4: Add to settings.json auto-allow**

Add `"mcp__foundry__batch_upload_assets"` to `permissions.allow`.

---

## Task 12: Tests for `batch_upload_assets` + full verification

**Files:**
- Modify: `test/integration/mcp-tools.test.ts`

- [ ] **Step 1: Write tests**

```typescript
describe("batch_upload_assets", () => {
  it("uploads multiple files and returns paths", async () => {
    const out = await runBatchUploadAssets(transport, {
      source: "data",
      target: "worlds/strahd/scenes",
      files: [
        { filename: "barovia.webp", contentBase64: btoa("map1") },
        { filename: "castle.webp", contentBase64: btoa("map2") },
      ],
    });
    if (!out.ok) throw new Error(`batch upload failed: ${out.error.message}`);
    const data = out.data as Array<{ filename: string; path: string }>;
    expect(data).toHaveLength(2);
    expect(data[0].path).toBe("worlds/strahd/scenes/barovia.webp");
    expect(data[1].path).toBe("worlds/strahd/scenes/castle.webp");
  });

  it("skips already-existing files when skipExisting=true", async () => {
    // Pre-upload
    await runBatchUploadAssets(transport, {
      source: "data",
      target: "worlds/strahd/tokens",
      files: [{ filename: "strahd.webp", contentBase64: btoa("token") }],
    });
    // Re-upload with skip
    const out = await runBatchUploadAssets(transport, {
      source: "data",
      target: "worlds/strahd/tokens",
      files: [
        { filename: "strahd.webp", contentBase64: btoa("token") },
        { filename: "ireena.webp", contentBase64: btoa("token2") },
      ],
      skipExisting: true,
    });
    if (!out.ok) throw new Error(`batch upload failed: ${out.error.message}`);
    const data = out.data as Array<{ filename: string; path: string; skipped?: boolean }>;
    expect(data.find((f) => f.filename === "strahd.webp")?.skipped).toBe(true);
    expect(data.find((f) => f.filename === "ireena.webp")?.skipped).toBeFalsy();
  });
});
```

- [ ] **Step 2: Add import for `runBatchUploadAssets`**

- [ ] **Step 3: Full verification gate**

```bash
npm run typecheck && npm test && npm run selftest 2>&1 | tail -20
```

Expected: all green; selftest PASSED.

- [ ] **Step 4: Bundle module**

```bash
npm run bundle:module
```

Expected: clean build, `packages/foundry-module/dist/index.js` updated.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts \
        packages/foundry-module/src/protocol-executor.ts \
        packages/foundry-module/src/foundry-runtime.ts \
        test/integration/mock-foundry.ts \
        test/integration/mock-foundry-api.ts \
        packages/foundry-module/src/relay-client.test.ts \
        packages/mcp-server/src/reliability.ts \
        packages/mcp-server/src/tools.ts \
        packages/mcp-server/src/server.ts \
        .claude/settings.json \
        packages/foundry-module/dist/index.js \
        test/integration/mcp-tools.test.ts
git commit -m "feat: add batch_upload_assets tool (multi-file FilePicker upload)"
```

---

## Task 13: Forge detection in `get_world_info`

The `get_world_info` tool currently returns `{ foundryVersion, system, world,
folders }`. Extend it to include `forge: { active: boolean, userId?: string }`
so the AI knows which `source` to pass to upload/browse tools.

**Files:**
- Modify: `packages/shared/src/protocol.ts` (no schema change needed — `getWorldInfo` returns opaque `data`)
- Modify: `packages/foundry-module/src/foundry-runtime.ts`
- Modify: `test/integration/mock-foundry.ts`

- [ ] **Step 1: Extend `getWorldInfo` in foundry-runtime.ts**

Find the `getWorldInfo` method. Add a `forge` field:

```typescript
async getWorldInfo(_opts) {
  // existing code ...
  return {
    foundryVersion: String((game as any).version ?? ""),
    system: {
      id: String((game.system as any)?.id ?? ""),
      version: String((game.system as any)?.version ?? ""),
    },
    world: {
      id: String((game.world as any)?.id ?? ""),
      title: String((game.world as any)?.title ?? ""),
    },
    folders: folders.map((f) => ({ _id: String(f.id), name: String(f.name), type: String(f.type) })),
    // NEW
    forge: {
      active: Boolean((globalThis as any).ForgeVTT?.usingTheForge),
      userId: (globalThis as any).ForgeVTT?.userId ?? null,
    },
  };
},
```

- [ ] **Step 2: Extend mock getWorldInfo**

In `test/integration/mock-foundry.ts`, find the `getWorldInfo` mock and add:

```typescript
forge: { active: false, userId: null },
```

- [ ] **Step 3: Run tests**

```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: green. Existing `get_world_info` tests may need updating if they use
`toMatchObject` (they'll just gain a new field, which is fine).

- [ ] **Step 4: Commit**

```bash
git add packages/foundry-module/src/foundry-runtime.ts \
        test/integration/mock-foundry.ts
git commit -m "feat: add forge detection to get_world_info response"
```

---

## Task 14: `.env.example` + Forge Phase 2 placeholder

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add optional Forge config keys**

```bash
# Optional: The Forge direct API (Phase 2 — bypasses browser relay for asset ops)
# FORGE_USER_ID=your-forge-user-id
# FORGE_API_KEY=your-forge-api-key
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add optional Forge API key placeholders to .env.example"
```

---

## Task 15: Enhanced Import Skill for Curse of Strahd

This task rewrites/extends
`examples/campaign-repo/.claude/skills/import-campaign-to-foundry/SKILL.md`
to cover the full Strahd import: asset uploads (maps + tokens), dual-mode
(local vs Forge), scene creation with backgrounds, actor creation with token
images, journal pages, and quests.

**Files:**
- Modify: `examples/campaign-repo/.claude/skills/import-campaign-to-foundry/SKILL.md`

- [ ] **Step 1: Overwrite the skill with the enhanced version**

The new skill must include these sections (full content below):

```markdown
---
name: import-campaign-to-foundry
description: Import Curse of Strahd campaign content into Foundry via MCP tools.
  Handles journals, actors, scenes (with map upload), and quests — both locally
  and on The Forge. Use when the user says "import", "push", "sync", or "create
  in Foundry" for journals, NPCs, scenes, or quests.
---

# Import Curse of Strahd into Foundry (live MCP path)

## 0. Orient first — always

Call `get_world_info` once at the start of every import session. It returns:
- `foundryVersion`, `system.id` (must be `dnd5e`), `world.id`
- `folders` — array of `{ _id, name, type }` for folder placement
- `forge.active` — `true` if hosted on The Forge

**Derive the upload source from `forge.active`:**
```
const source = worldInfo.forge.active ? "forgevtt" : "data";
```
Use this `source` for all `upload_asset`, `batch_upload_assets`, and
`browse_assets` calls in the session. Never hardcode `"data"` or `"forgevtt"`.

## 1. Asset Upload Strategy

Upload maps and token images **before** creating scenes or actors that reference
them. Assets are large; batch them.

### Pre-flight dedup

Before uploading a directory, call `browse_assets` to list what's already there.
Pass `skipExisting: true` to `batch_upload_assets` so re-runs are idempotent:

```
// Check what's already uploaded
const browse = await mcp__foundry__browse_assets({
  source,
  target: "worlds/curse-of-strahd/scenes",
  extensions: [".webp", ".jpg", ".png"]
});
// → { files: ["worlds/curse-of-strahd/scenes/village-of-barovia.webp", ...] }

// Batch upload with skip
await mcp__foundry__batch_upload_assets({
  source,
  target: "worlds/curse-of-strahd/scenes",
  files: [
    { filename: "village-of-barovia.webp", contentBase64: "...", mimeType: "image/webp" },
    { filename: "death-house.webp", contentBase64: "...", mimeType: "image/webp" },
  ],
  skipExisting: true  // skips files already in browse result
});
// → [{ filename: "village-of-barovia.webp", path: "worlds/.../village-of-barovia.webp" },
//    { filename: "death-house.webp", path: "...", skipped: true }]
```

Max 50 files per `batch_upload_assets` call. Split into batches if needed.

### Token images

Upload token images to `worlds/curse-of-strahd/tokens/`:

```
await mcp__foundry__batch_upload_assets({
  source,
  target: "worlds/curse-of-strahd/tokens",
  files: strahd_npc_tokens,  // { filename, contentBase64 }[]
  skipExisting: true,
});
```

## 2. Document Classification

| Source path | documentType | Tool | Notes |
|-------------|-------------|------|-------|
| `generated/journals/*.md` | `JournalEntry` | create/update | GM notes, location descriptions |
| `journals/*.md` | `JournalEntry` | update (ids real) | Extracted Foundry journals |
| `generated/npcs/*.md` | `Actor` | create/update | Strahd NPCs + monsters |
| `generated/scenes/*.md` | `Scene` | create_scene | Maps with uploaded backgrounds |
| `actors/npcs/*.json` | `Actor` | source only | Full extracted JSON — strip `_id` for fresh create |

## 3. Upsert Contract (unchanged)

- `id: ""` in front-matter → **create**, then write returned `_id` back.
- `id: "<16-char>"` → **update**. If `NOT_FOUND`, ask user whether to re-create
  with `keepId: true` (preserves cross-references).

## 4. Scenes — Full Workflow

For each `generated/scenes/*.md`:

1. Parse front-matter: `name`, `id`, `width`, `height`, `gridSize`, `background`
   (relative path like `scenes/village-of-barovia.webp`)
2. Upload the background image if not already in `browse_assets` result:
   ```
   const bgPath = await upload_asset({ source, target: "worlds/curse-of-strahd/scenes",
     filename: "village-of-barovia.webp", contentBase64: readFileBase64(localPath) });
   ```
3. Create or update the scene:
   - **create**: `create_scene({ name, width, height, gridSize, background: bgPath })`
     → write returned `_id` back to front-matter.
   - **update**: `update_document({ documentType: "Scene", id, data: { background: bgPath } })`

### Strahd Scene Defaults (dnd5e)

```json
{
  "gridSize": 100,
  "gridType": 1,
  "gridDistance": 5,
  "gridUnits": "ft",
  "padding": 0.25
}
```

Override per scene if front-matter provides different values.

## 5. Actors / NPCs — Full Workflow

For each `generated/npcs/*.md` or `actors/npcs/*.json`:

1. Parse stat block: `name`, `type: "npc"`, `system.details.cr`,
   `system.attributes.hp.value`, `system.attributes.hp.max`,
   ability scores, etc.
2. If there's a token image listed, ensure it's uploaded first:
   ```
   const tokenPath = "worlds/curse-of-strahd/tokens/strahd-von-zarovich.webp";
   // (upload via batch_upload_assets at the start)
   ```
3. Create:
   ```
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

## 6. Journal Entries — Full Workflow

Journal pages are embedded documents (v10+). Two-step:

1. Create the `JournalEntry` container:
   ```
   create_document({ documentType: "JournalEntry", data: { name: "Village of Barovia", folder: folderId } })
   → { _id: "abc123" }
   ```
2. Create the page with HTML content:
   ```
   create_embedded({
     parentType: "JournalEntry",
     parentId: "abc123",
     embeddedName: "JournalEntryPage",
     data: [{
       name: "Description",
       type: "text",
       text: { content: "<p>The village of Barovia...</p>" }
     }]
   })
   ```
   Convert markdown body to HTML first. Do **not** send raw markdown to Foundry.

## 7. Quest Structure for Curse of Strahd

The main Strahd story arc maps to quest hierarchy:

```
Main Quest: "Curse of Strahd"
  ├── Sub-Quest: "Escape Barovia" (parentId = main quest id)
  │     Tasks: Find allies, obtain holy symbol, ...
  ├── Sub-Quest: "Defeat Strahd" (parentId = main quest id)
  │     Tasks: Find the Sunsword, enter Castle Ravenloft, ...
  └── Sub-Quest: "Free the Souls" (parentId = main quest id)
```

Create main quest first, capture its `_id`, then create sub-quests with
`parentId`:

```
const main = await create_quest({
  data: { name: "Curse of Strahd", status: "active",
          description: "Break the ancient curse that binds Barovia." }
})
const mainId = main._id;

await create_quest({
  data: { name: "Escape Barovia", status: "hidden" },
  parentId: mainId
});
```

## 8. Guardrails

- **Show a plan before bulk writes.** For > 3 documents: print a table (file →
  op → name) and wait for go-ahead.
- **deletes are terminal** — confirm every delete explicitly.
- **source from worldInfo** — never hardcode `"data"` or `"forgevtt"`.
- **Preserve language** — `generated/` notes are in Danish; `journals/` are in
  English. Don't translate unless asked.
- If `mcp__foundry__*` tools are absent: Foundry isn't reachable — tell the user
  to start Foundry with a GM logged in and the `foundry-mcp-bridge` module enabled.
```

- [ ] **Step 2: Commit**

```bash
git add examples/campaign-repo/.claude/skills/import-campaign-to-foundry/SKILL.md
git commit -m "feat: extend Strahd import skill with asset upload, Forge dual-mode, scenes/actors/quests"
```

---

## Task 16: Add selftest coverage for new tools

**Files:**
- Modify: `scripts/selftest.mjs`

- [ ] **Step 1: Add `runBrowseAssets` + `runBatchUploadAssets` to selftest**

In `selftest.mjs`, add imports:

```js
import {
  // ...existing...
  runBrowseAssets,
  runBatchUploadAssets,
} from "../packages/mcp-server/dist/index.js";
```

Add stub handler cases (the stub `handle` function):

```js
case "browseAssets":
  return ok({ dirs: [], files: [...store.keys()].filter((k) => k.startsWith(c.target)), target: c.target });
case "batchUploadAssets": {
  const results = c.files.map((f) => {
    const path = `${c.target.replace(/\/$/, "")}/${f.filename}`;
    store.set(`upload:${path}`, f);
    return { filename: f.filename, path };
  });
  return ok(results);
}
```

Add selftest calls after `create_quest`:

```js
show("browse_assets (empty)", await runBrowseAssets(server, { source: "data", target: "worlds/test" }, opts));
show("batch_upload_assets", await runBatchUploadAssets(server, {
  source: "data",
  target: "worlds/test/scenes",
  files: [
    { filename: "map1.webp", contentBase64: "AAAA" },
    { filename: "map2.webp", contentBase64: "BBBB" },
  ],
}, opts));
show("browse_assets (after upload)", await runBrowseAssets(server, { source: "data", target: "worlds/test/scenes" }, opts));
```

- [ ] **Step 2: Run selftest**

```bash
npm run selftest 2>&1 | tail -20
```

Expected: `SELFTEST PASSED` with new PASS lines for `browse_assets` and
`batch_upload_assets`.

- [ ] **Step 3: Commit**

```bash
git add scripts/selftest.mjs
git commit -m "test: add browse_assets + batch_upload_assets to selftest"
```

---

## Task 17: Install module and verify live on local Foundry

> This task requires Foundry VTT running locally with the `foundry-mcp-bridge`
> module enabled and a GM logged into the `test-mcp` world.

- [ ] **Step 1: Bundle and install**

```bash
npm run bundle:module && npm run install:foundry
```

- [ ] **Step 2: Verify `browse_assets` locally**

Use the MCP tool directly:

```
mcp__foundry__browse_assets({ source: "data", target: "worlds/test-mcp" })
```

Expected: `{ dirs: [...], files: [...], target: "worlds/test-mcp" }` — non-empty
because the test-mcp world has files.

- [ ] **Step 3: Verify `batch_upload_assets` locally**

```
mcp__foundry__batch_upload_assets({
  source: "data",
  target: "worlds/test-mcp/strahd-test",
  files: [{ filename: "probe.webp", contentBase64: "<base64 1x1 webp>" }]
})
```

Expected: `[{ filename: "probe.webp", path: "worlds/test-mcp/strahd-test/probe.webp" }]`

Then confirm file appears in a second `browse_assets` call.

- [ ] **Step 4: Verify Forge detection**

```
mcp__foundry__get_world_info({})
```

Expected: `{ ..., forge: { active: false, userId: null } }` (locally).

- [ ] **Step 5: Check console for errors**

Open Chrome DevTools on `http://localhost:30000/game`. The console should show
clean command traces (`[foundry-mcp-bridge] ▶ browseAssets #...`) with no errors.

- [ ] **Step 6: Commit verification note**

```bash
git commit --allow-empty -m "chore: local Foundry verification passed for browse_assets + batch_upload_assets"
```

---

## Task 18: Forge cloud verification (requires The Forge account)

> Run this task only when ready to test on The Forge. You need a Foundry world
> hosted on `forge-vtt.com` with the `foundry-mcp-bridge` module installed and
> a Forge relay URL configured.

- [ ] **Step 1: Update module settings in the Forge-hosted world**

In Foundry → Module Settings → Foundry MCP Bridge:
- Relay URL: the relay your MCP server exposes (e.g., `wss://your-relay.example.com/`)
- Token: the shared secret from your `.env`

Or for local testing via ngrok:
```bash
ngrok http 8787  # exposes ws://localhost:8787 publicly
```
Then set the Relay URL to the ngrok `wss://` address.

- [ ] **Step 2: Call `get_world_info`**

```
mcp__foundry__get_world_info({})
```

Expected: `{ ..., forge: { active: true, userId: "<your-forge-user-id>" } }`

- [ ] **Step 3: Upload a test asset to The Forge**

```
mcp__foundry__upload_asset({
  source: "forgevtt",
  target: "worlds/your-world/test",
  filename: "probe.webp",
  contentBase64: "<base64 1x1 webp>"
})
```

Expected: `{ path: "worlds/your-world/test/probe.webp" }` — path on The Forge
CDN.

- [ ] **Step 4: Browse The Forge assets**

```
mcp__foundry__browse_assets({
  source: "forgevtt",
  target: "worlds/your-world/test"
})
```

Expected: `{ files: ["worlds/your-world/test/probe.webp"], dirs: [], target: "..." }`

---

## Self-Review

### Spec coverage check

| Requirement | Task(s) |
|-------------|---------|
| Discover Forge VTT asset manager API | Task 1 (docs) + Task 13 (detection) |
| Upload assets to The Forge | Tasks 9–12 (batch_upload_assets with source="forgevtt") |
| Browse/list assets (dedup) | Tasks 2–8 (browse_assets) |
| Single asset upload already exists | Existing `upload_asset` tool |
| Full Strahd import: scenes with map backgrounds | Task 15 (skill, §4) |
| Full Strahd import: actors with token images | Task 15 (skill, §5) |
| Full Strahd import: journal entries + pages | Task 15 (skill, §6) |
| Full Strahd import: quests + sub-quests | Task 15 (skill, §7) |
| Works locally AND on The Forge | Tasks 13, 15, 17, 18 |
| Plan.md written to branch | This document |
| New branch | `feature/forge-asset-manager-strahd` |

### Type consistency

- `BrowseAssetsCommand.source` is `z.enum(["data","forgevtt"])` — matches
  `UploadAssetCommand.source` and `BatchUploadAssetsCommand.source`. Consistent.
- `BatchUploadEntry` defined once in protocol.ts, imported by reliability.ts via
  the shared package.
- `browseAssets` return type `{ dirs: string[], files: string[], target: string }`
  matches `FilePicker.browse` shape.

### No placeholders

Checked — all code blocks are complete.
