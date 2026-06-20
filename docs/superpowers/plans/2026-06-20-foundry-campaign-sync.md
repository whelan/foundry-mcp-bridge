# Foundry Campaign Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic reconcile/sync layer between a campaign notes repo and a live Foundry world — a committed `foundry-sync.json` manifest plus a pure planner that classifies every document/asset/quest as create / update / unchanged / remote-ahead / conflict, with Foundry-wins for documents and bidirectional quests (structure pushes, progress pulls).

**Architecture:** A new workspace package `packages/campaign-sync` holds the testable pure core (`planner.ts`) plus `manifest.ts`, `notes.ts`, `fql.ts`, and a thin `cli.ts`. It does **no** Foundry I/O — the `foundry-sync` skill fetches live state via the `mcp__foundry__*` tools, pipes it to the CLI, and executes the plan. Mirrors the repo's "testable core / thin shell" convention (`protocol-executor`, `reliability`).

**Tech Stack:** TypeScript (NodeNext, composite project refs), zod (schema), `yaml` (front-matter), `node:crypto` (hashing), vitest (tests). Reuses `@foundry-mcp-bridge/shared` for `DocumentType`.

**Spec:** `docs/superpowers/specs/2026-06-20-foundry-campaign-sync-design.md`

---

## File structure

New package `packages/campaign-sync`:

| File | Responsibility |
| --- | --- |
| `package.json` | workspace package manifest (`@foundry-mcp-bridge/campaign-sync`) |
| `tsconfig.json` | composite build, references `../shared` |
| `src/types.ts` | shared types: `EntityType`, `Manifest`, `RepoEntity`, `LiveState`, `QuestState`, `Plan` |
| `src/hash.ts` | `hashContent(s)` → `"sha256:…"` |
| `src/manifest.ts` | zod schema + `parseManifest` / `serializeManifest` / `loadManifest` / `saveManifest` |
| `src/notes.ts` | parse note front-matter + body, classify by folder, content hash (excludes managed keys) |
| `src/fql.ts` | extract the FQL quest object, `questProgressHash`, write progress into a note's front-matter |
| `src/planner.ts` | **pure** `computePlan(manifest, repo, live) → Plan` + `planToTable` |
| `src/cli.ts` | thin `plan` / `record` CLI; no business logic |
| `src/*.test.ts` | co-located vitest tests |

Modified: root `tsconfig.json`, `tsconfig.test.json`, `package.json` (workspaces already globs `packages/*`). New skill files under `examples/campaign-repo/.claude/skills/`.

**Deliberate simplifications (within approved spec):**
- Quest **hierarchy ordering** (parents before children) is handled by the `import-campaign-to-foundry` skill's existing §7 create-order, not the planner. The planner orders items as creates → updates/pulls → skips in stable source order. (Spec §11 topological ordering deferred to the skill.)
- Content hash for a note **excludes** the managed progress keys (`status`, `tasks`) so pulling quest progress into front-matter does not register as a local edit next run.

---

## Task 1: Scaffold the `campaign-sync` package

**Files:**
- Create: `packages/campaign-sync/package.json`
- Create: `packages/campaign-sync/tsconfig.json`
- Create: `packages/campaign-sync/src/index.ts`
- Modify: `tsconfig.json` (root, add reference)
- Modify: `tsconfig.test.json` (add path alias)
- Modify: `vitest.config.ts` (add resolve alias)

- [ ] **Step 1: Create `packages/campaign-sync/package.json`**

```json
{
  "name": "@foundry-mcp-bridge/campaign-sync",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "foundry-sync": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc --build",
    "clean": "tsc --build --clean"
  },
  "dependencies": {
    "@foundry-mcp-bridge/shared": "0.1.0",
    "yaml": "^2.6.1",
    "zod": "^3.24.1"
  }
}
```

- [ ] **Step 2: Create `packages/campaign-sync/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/campaign-sync/src/index.ts`** (placeholder export so the build has an entry)

```ts
export * from "./types.js";
export * from "./manifest.js";
export * from "./planner.js";
```

- [ ] **Step 4: Add the package reference to root `tsconfig.json`**

Replace the `references` array so it reads:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/foundry-module" },
    { "path": "./packages/mcp-server" },
    { "path": "./packages/campaign-sync" }
  ]
}
```

- [ ] **Step 5: Add the test path alias to `tsconfig.test.json`**

In `compilerOptions.paths`, add the campaign-sync entry so it reads:

```json
"paths": {
  "@foundry-mcp-bridge/shared": ["./packages/shared/src/index.ts"],
  "@foundry-mcp-bridge/campaign-sync": ["./packages/campaign-sync/src/index.ts"]
}
```

- [ ] **Step 6: Add the vitest resolve alias to `vitest.config.ts`**

In `resolve.alias`, add below the shared alias:

```ts
"@foundry-mcp-bridge/campaign-sync": fileURLToPath(
  new URL("./packages/campaign-sync/src/index.ts", import.meta.url),
),
```

- [ ] **Step 7: Install and verify the build wiring**

Run: `npm install && npm run build`
Expected: PASS (build emits `packages/campaign-sync/dist/index.js`; will currently fail to resolve `./types.js` etc. — that's fine, Task 2 adds them). If `index.ts` imports fail the build, temporarily make `index.ts` just `export {};` until Task 2, then restore. Simpler: keep `index.ts` as `export {};` for now.

Replace `src/index.ts` content with:

```ts
export {};
```

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/campaign-sync tsconfig.json tsconfig.test.json vitest.config.ts package-lock.json
git commit -m "feat(campaign-sync): scaffold workspace package"
```

---

## Task 2: Types + manifest schema (zod) with read/write

**Files:**
- Create: `packages/campaign-sync/src/types.ts`
- Create: `packages/campaign-sync/src/manifest.ts`
- Create: `packages/campaign-sync/src/manifest.test.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
import type { DocumentType } from "@foundry-mcp-bridge/shared";

/** Importable Foundry document types plus the logical FQL-backed Quest. */
export type EntityType = DocumentType | "Quest";

export interface AssetRecord {
  localPath: string;
  contentHash: string;
  remotePath: string;
}

export interface ManifestEntity {
  documentType: EntityType;
  foundryId: string;
  contentHash: string;
  remoteModifiedTime: number;
  /** Quests only: hash of pulled progress fields. */
  progressHash?: string;
  lastImportedAt: string;
  assets: AssetRecord[];
}

export interface Manifest {
  version: 1;
  world: { id: string; system: string; forge: boolean };
  /** Keyed by repo-relative source path. */
  entities: Record<string, ManifestEntity>;
}

/** A repo-side note after parsing + hashing. */
export interface RepoEntity {
  source: string;
  documentType: EntityType;
  contentHash: string;
  assets: { localPath: string; contentHash: string }[];
}

/** Live FQL quest progress, parsed from the JournalEntry flag. */
export interface QuestState {
  status: string;
  tasks: { name: string; completed: boolean; failed: boolean }[];
  dateStart: number | null;
  dateEnd: number | null;
}

/** A live Foundry document, keyed by foundryId in LiveState.docs. */
export interface LiveDoc {
  foundryId: string;
  modifiedTime: number;
  /** Present only for quests. */
  quest?: QuestState;
}

export interface LiveState {
  world: { id: string };
  docs: Record<string, LiveDoc>;
}

export type PlanAction =
  | "create"
  | "update"
  | "unchanged"
  | "remote-ahead"
  | "conflict"
  | "missing-remote"
  | "quest-push-structure"
  | "quest-pull-progress"
  | "quest-push-and-pull";

export type AssetAction = "upload" | "reupload" | "unchanged";

export interface PlanItem {
  source: string;
  documentType: EntityType;
  action: PlanAction;
  foundryId?: string;
  reason: string;
  assets: { localPath: string; action: AssetAction }[];
}

export interface Plan {
  world: { id: string; matches: boolean };
  blocked: boolean;
  items: PlanItem[];
}
```

- [ ] **Step 2: Write the failing test `src/manifest.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseManifest, serializeManifest, emptyManifest } from "./manifest.js";

const sample = {
  version: 1,
  world: { id: "curse-of-strahd", system: "dnd5e", forge: true },
  entities: {
    "generated/npcs/strahd.md": {
      documentType: "Actor",
      foundryId: "OY1GPYw1bt1vyS2Q",
      contentHash: "sha256:abc",
      remoteModifiedTime: 1781963876080,
      lastImportedAt: "2026-06-20T16:00:00Z",
      assets: [],
    },
  },
};

describe("manifest", () => {
  it("round-trips a valid manifest", () => {
    const m = parseManifest(JSON.stringify(sample));
    expect(m.world.id).toBe("curse-of-strahd");
    const again = parseManifest(serializeManifest(m));
    expect(again).toEqual(m);
  });

  it("emptyManifest builds a version-1 manifest for a world", () => {
    const m = emptyManifest({ id: "w", system: "dnd5e", forge: false });
    expect(m.version).toBe(1);
    expect(m.entities).toEqual({});
  });

  it("rejects a malformed manifest", () => {
    expect(() => parseManifest('{"version":2}')).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/campaign-sync/src/manifest.test.ts`
Expected: FAIL (cannot resolve `./manifest.js`).

- [ ] **Step 4: Write `src/manifest.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { Manifest } from "./types.js";

const AssetRecordSchema = z.object({
  localPath: z.string().min(1),
  contentHash: z.string().min(1),
  remotePath: z.string().min(1),
});

const EntitySchema = z.object({
  documentType: z.string().min(1),
  foundryId: z.string().min(1),
  contentHash: z.string().min(1),
  remoteModifiedTime: z.number(),
  progressHash: z.string().min(1).optional(),
  lastImportedAt: z.string().min(1),
  assets: z.array(AssetRecordSchema),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  world: z.object({ id: z.string().min(1), system: z.string(), forge: z.boolean() }),
  entities: z.record(EntitySchema),
});

export function parseManifest(text: string): Manifest {
  return ManifestSchema.parse(JSON.parse(text)) as Manifest;
}

export function serializeManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

export function emptyManifest(world: Manifest["world"]): Manifest {
  return { version: 1, world, entities: {} };
}

export function loadManifest(path: string, world: Manifest["world"]): Manifest {
  return existsSync(path) ? parseManifest(readFileSync(path, "utf8")) : emptyManifest(world);
}

export function saveManifest(path: string, m: Manifest): void {
  writeFileSync(path, serializeManifest(m));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/campaign-sync/src/manifest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Restore `src/index.ts` to real exports**

```ts
export * from "./types.js";
export * from "./manifest.js";
```

- [ ] **Step 7: Commit**

```bash
git add packages/campaign-sync/src
git commit -m "feat(campaign-sync): manifest types + zod schema with round-trip"
```

---

## Task 3: Hashing + note parsing/classification

**Files:**
- Create: `packages/campaign-sync/src/hash.ts`
- Create: `packages/campaign-sync/src/notes.ts`
- Create: `packages/campaign-sync/src/notes.test.ts`

- [ ] **Step 1: Write `src/hash.ts`**

```ts
import { createHash } from "node:crypto";

export function hashContent(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}
```

- [ ] **Step 2: Write the failing test `src/notes.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseNote, classifyType, DEFAULT_TYPE_MAP, MANAGED_KEYS } from "./notes.js";

const note = `---
id: ""
name: Strahd
status: active
tasks:
  - name: Find the tome
    completed: true
---
# Strahd

Body text.
`;

describe("notes", () => {
  it("classifies by folder prefix", () => {
    expect(classifyType("generated/npcs/strahd.md", DEFAULT_TYPE_MAP)).toBe("Actor");
    expect(classifyType("generated/quests/escape.md", DEFAULT_TYPE_MAP)).toBe("Quest");
    expect(classifyType("generated/scenes/barovia.md", DEFAULT_TYPE_MAP)).toBe("Scene");
  });

  it("parses front-matter + body and exposes the id", () => {
    const n = parseNote("generated/npcs/strahd.md", note, DEFAULT_TYPE_MAP);
    expect(n.frontMatter.name).toBe("Strahd");
    expect(n.documentType).toBe("Actor");
    expect(n.body.trim()).toContain("Body text.");
  });

  it("contentHash excludes managed (progress) keys", () => {
    const withProgress = parseNote("generated/quests/x.md", note, DEFAULT_TYPE_MAP);
    const noProgress = note.replace("status: active", "status: inactive");
    const other = parseNote("generated/quests/x.md", noProgress, DEFAULT_TYPE_MAP);
    // status is a MANAGED_KEY, so flipping it must NOT change the content hash.
    expect(MANAGED_KEYS).toContain("status");
    expect(withProgress.contentHash).toBe(other.contentHash);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/campaign-sync/src/notes.test.ts`
Expected: FAIL (cannot resolve `./notes.js`).

- [ ] **Step 4: Write `src/notes.ts`**

```ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hashContent } from "./hash.js";
import type { EntityType } from "./types.js";

/** Front-matter keys owned by the live world (pulled in), excluded from the content hash. */
export const MANAGED_KEYS = ["status", "tasks"] as const;

export type TypeMap = { prefix: string; type: EntityType }[];

export const DEFAULT_TYPE_MAP: TypeMap = [
  { prefix: "generated/journals/", type: "JournalEntry" },
  { prefix: "generated/npcs/", type: "Actor" },
  { prefix: "generated/scenes/", type: "Scene" },
  { prefix: "generated/quests/", type: "Quest" },
];

export function classifyType(source: string, map: TypeMap): EntityType | undefined {
  return map.find((m) => source.startsWith(m.prefix))?.type;
}

export interface ParsedNote {
  source: string;
  documentType: EntityType;
  frontMatter: Record<string, unknown>;
  body: string;
  contentHash: string;
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseNote(source: string, raw: string, map: TypeMap): ParsedNote {
  const documentType = classifyType(source, map) ?? "JournalEntry";
  const match = FM_RE.exec(raw);
  const frontMatter = match ? ((parseYaml(match[1]) as Record<string, unknown>) ?? {}) : {};
  const body = match ? match[2] : raw;

  // Hash authored content only: front-matter minus MANAGED_KEYS, plus body.
  const authored: Record<string, unknown> = { ...frontMatter };
  for (const k of MANAGED_KEYS) delete authored[k];
  const contentHash = hashContent(stringifyYaml(authored) + "\n---\n" + body);

  return { source, documentType, frontMatter, body, contentHash };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/campaign-sync/src/notes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/campaign-sync/src/hash.ts packages/campaign-sync/src/notes.ts packages/campaign-sync/src/notes.test.ts
git commit -m "feat(campaign-sync): note parsing, folder classification, managed-key-aware hashing"
```

---

## Task 4: FQL quest extraction + progress hashing + writeback

**Files:**
- Create: `packages/campaign-sync/src/fql.ts`
- Create: `packages/campaign-sync/src/fql.test.ts`

Captured live shape (2026-06-20): an FQL quest is a `JournalEntry` with the quest object at `flags["forien-quest-log"].json`, holding `status`, `tasks[]`, `date`, etc.

- [ ] **Step 1: Write the failing test `src/fql.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { extractQuest, questProgressHash, renderProgressFrontMatter } from "./fql.js";

const journalEntry = {
  _id: "508O4p7zIb94Gy1b",
  flags: {
    "forien-quest-log": {
      json: {
        name: "Escape Barovia",
        status: "active",
        tasks: [
          { name: "Find the tome", completed: true, failed: false },
          { name: "Leave the village", completed: false, failed: false },
        ],
        date: { create: 1, start: 2, end: null },
      },
    },
  },
};

describe("fql", () => {
  it("extracts the quest state from a JournalEntry flag", () => {
    const q = extractQuest(journalEntry);
    expect(q.status).toBe("active");
    expect(q.tasks).toHaveLength(2);
    expect(q.tasks[0]).toEqual({ name: "Find the tome", completed: true, failed: false });
    expect(q.dateStart).toBe(2);
    expect(q.dateEnd).toBeNull();
  });

  it("throws loudly on an unrecognized shape", () => {
    expect(() => extractQuest({ _id: "x", flags: {} })).toThrow(/forien-quest-log/);
  });

  it("progress hash changes when a task is checked off", () => {
    const q1 = extractQuest(journalEntry);
    const q2 = { ...q1, tasks: [{ ...q1.tasks[0] }, { ...q1.tasks[1], completed: true }] };
    expect(questProgressHash(q1)).not.toBe(questProgressHash(q2));
  });

  it("renders progress as front-matter fields", () => {
    const q = extractQuest(journalEntry);
    const fm = renderProgressFrontMatter(q);
    expect(fm.status).toBe("active");
    expect(fm.tasks).toEqual([
      { name: "Find the tome", completed: true },
      { name: "Leave the village", completed: false },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/campaign-sync/src/fql.test.ts`
Expected: FAIL (cannot resolve `./fql.js`).

- [ ] **Step 3: Write `src/fql.ts`**

```ts
import { hashContent } from "./hash.js";
import type { QuestState } from "./types.js";

interface RawTask {
  name?: string;
  completed?: boolean;
  failed?: boolean;
}

export function extractQuest(journalEntry: unknown): QuestState {
  const json = (journalEntry as { flags?: Record<string, { json?: unknown }> })?.flags?.[
    "forien-quest-log"
  ]?.json as
    | { status?: string; tasks?: RawTask[]; date?: { start?: number | null; end?: number | null } }
    | undefined;
  if (!json || typeof json.status !== "string") {
    throw new Error("Not a Forien's Quest Log quest: missing flags[\"forien-quest-log\"].json");
  }
  return {
    status: json.status,
    tasks: (json.tasks ?? []).map((t) => ({
      name: String(t.name ?? ""),
      completed: Boolean(t.completed),
      failed: Boolean(t.failed),
    })),
    dateStart: json.date?.start ?? null,
    dateEnd: json.date?.end ?? null,
  };
}

export function questProgressHash(q: QuestState): string {
  return hashContent(
    JSON.stringify({
      status: q.status,
      tasks: q.tasks.map((t) => [t.name, t.completed, t.failed]),
      dateStart: q.dateStart,
      dateEnd: q.dateEnd,
    }),
  );
}

export function renderProgressFrontMatter(q: QuestState): Record<string, unknown> {
  return {
    status: q.status,
    tasks: q.tasks.map((t) => ({ name: t.name, completed: t.completed })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/campaign-sync/src/fql.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/campaign-sync/src/fql.ts packages/campaign-sync/src/fql.test.ts
git commit -m "feat(campaign-sync): extract FQL quest state, progress hash, front-matter render"
```

---

## Task 5: Planner — documents (push-primary, Foundry-wins)

**Files:**
- Create: `packages/campaign-sync/src/planner.ts`
- Create: `packages/campaign-sync/src/planner.test.ts`

- [ ] **Step 1: Write the failing test `src/planner.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { computePlan } from "./planner.js";
import type { Manifest, RepoEntity, LiveState } from "./types.js";

const world = { id: "w", system: "dnd5e", forge: true };

function manifest(entities: Manifest["entities"] = {}): Manifest {
  return { version: 1, world, entities };
}
function live(docs: LiveState["docs"] = {}): LiveState {
  return { world: { id: "w" }, docs };
}
const actor = (source: string, hash: string): RepoEntity => ({
  source,
  documentType: "Actor",
  contentHash: hash,
  assets: [],
});

describe("planner — documents", () => {
  it("create when no manifest entry", () => {
    const plan = computePlan(manifest(), [actor("npcs/a.md", "sha256:1")], live());
    expect(plan.items[0]?.action).toBe("create");
  });

  it("unchanged when both hashes/mtime match", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:1")], live({ F1: { foundryId: "F1", modifiedTime: 100 } }));
    expect(plan.items[0]?.action).toBe("unchanged");
  });

  it("update when only repo changed", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:2")], live({ F1: { foundryId: "F1", modifiedTime: 100 } }));
    expect(plan.items[0]?.action).toBe("update");
  });

  it("remote-ahead when only Foundry changed", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:1")], live({ F1: { foundryId: "F1", modifiedTime: 200 } }));
    expect(plan.items[0]?.action).toBe("remote-ahead");
  });

  it("conflict when both changed (Foundry wins → skip)", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:2")], live({ F1: { foundryId: "F1", modifiedTime: 200 } }));
    expect(plan.items[0]?.action).toBe("conflict");
  });

  it("missing-remote when manifest id is gone in Foundry", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:1")], live({}));
    expect(plan.items[0]?.action).toBe("missing-remote");
  });

  it("blocks on world mismatch", () => {
    const plan = computePlan(manifest(), [actor("npcs/a.md", "sha256:1")], { world: { id: "other" }, docs: {} });
    expect(plan.blocked).toBe(true);
    expect(plan.world.matches).toBe(false);
    expect(plan.items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/campaign-sync/src/planner.test.ts`
Expected: FAIL (cannot resolve `./planner.js`).

- [ ] **Step 3: Write `src/planner.ts` (documents + world-mismatch only for now)**

```ts
import { questProgressHash } from "./fql.js";
import type { Manifest, RepoEntity, LiveState, Plan, PlanItem, AssetAction } from "./types.js";

export function computePlan(manifest: Manifest, repo: RepoEntity[], live: LiveState): Plan {
  const matches = live.world.id === manifest.world.id;
  if (!matches) {
    return { world: { id: manifest.world.id, matches: false }, blocked: true, items: [] };
  }

  const items: PlanItem[] = [];
  for (const e of repo) {
    const m = manifest.entities[e.source];
    const l = m ? live.docs[m.foundryId] : undefined;
    const assets = planAssets(e, m?.assets ?? []);
    const base = { source: e.source, documentType: e.documentType, foundryId: m?.foundryId, assets };

    if (e.documentType === "Quest") {
      items.push(planQuest(e, m, l, base));
      continue;
    }

    if (!m) {
      items.push({ ...base, action: "create", reason: "no manifest entry" });
    } else if (!l) {
      items.push({ ...base, action: "missing-remote", reason: "id not found in world" });
    } else {
      const localChanged = e.contentHash !== m.contentHash;
      const remoteChanged = l.modifiedTime !== m.remoteModifiedTime;
      if (!localChanged && !remoteChanged) items.push({ ...base, action: "unchanged", reason: "in sync" });
      else if (localChanged && !remoteChanged) items.push({ ...base, action: "update", reason: "repo changed" });
      else if (!localChanged && remoteChanged) items.push({ ...base, action: "remote-ahead", reason: "world changed (Foundry wins)" });
      else items.push({ ...base, action: "conflict", reason: "both changed (Foundry wins → skip)" });
    }
  }
  return { world: { id: manifest.world.id, matches: true }, blocked: false, items: order(items) };
}

function planAssets(e: RepoEntity, recorded: { localPath: string; contentHash: string }[]) {
  return e.assets.map((a) => {
    const prev = recorded.find((r) => r.localPath === a.localPath);
    const action: AssetAction = !prev ? "upload" : prev.contentHash !== a.contentHash ? "reupload" : "unchanged";
    return { localPath: a.localPath, action };
  });
}

// Quest planning is fleshed out in Task 6; documents path is complete here.
function planQuest(
  e: RepoEntity,
  m: Manifest["entities"][string] | undefined,
  l: LiveState["docs"][string] | undefined,
  base: Omit<PlanItem, "action" | "reason">,
): PlanItem {
  if (!m) return { ...base, action: "create", reason: "no manifest entry" };
  if (!l) return { ...base, action: "missing-remote", reason: "quest id not found in world" };
  const structureChanged = e.contentHash !== m.contentHash;
  const progressChanged = l.quest ? questProgressHash(l.quest) !== m.progressHash : false;
  if (structureChanged && progressChanged) return { ...base, action: "quest-push-and-pull", reason: "structure + progress changed" };
  if (structureChanged) return { ...base, action: "quest-push-structure", reason: "structure changed" };
  if (progressChanged) return { ...base, action: "quest-pull-progress", reason: "progress changed (pull)" };
  return { ...base, action: "unchanged", reason: "in sync" };
}

const RANK: Record<string, number> = {
  create: 0,
  update: 1,
  "quest-push-structure": 1,
  "quest-push-and-pull": 1,
  "quest-pull-progress": 2,
  "remote-ahead": 3,
  conflict: 3,
  "missing-remote": 3,
  unchanged: 4,
};

function order(items: PlanItem[]): PlanItem[] {
  return [...items].sort(
    (a, b) => (RANK[a.action] ?? 9) - (RANK[b.action] ?? 9) || a.source.localeCompare(b.source),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/campaign-sync/src/planner.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/campaign-sync/src/planner.ts packages/campaign-sync/src/planner.test.ts
git commit -m "feat(campaign-sync): planner document classification + world-mismatch hard stop"
```

---

## Task 6: Planner — quests (field-ownership split) tests

The quest logic already lives in `planQuest` (Task 5). This task locks it with tests.

**Files:**
- Modify: `packages/campaign-sync/src/planner.test.ts` (append a quest describe block)

- [ ] **Step 1: Append the failing quest tests to `src/planner.test.ts`**

```ts
import { questProgressHash } from "./fql.js";
import type { QuestState } from "./types.js";

const quest = (source: string, hash: string): RepoEntity => ({
  source,
  documentType: "Quest",
  contentHash: hash,
  assets: [],
});
const qstate = (status: string): QuestState => ({ status, tasks: [], dateStart: null, dateEnd: null });

describe("planner — quests", () => {
  it("quest-pull-progress when only live progress changed", () => {
    const ph = questProgressHash(qstate("inactive"));
    const m = manifest({
      "quests/q.md": { documentType: "Quest", foundryId: "Q1", contentHash: "sha256:1", remoteModifiedTime: 1, progressHash: ph, lastImportedAt: "t", assets: [] },
    });
    const liveQ = live({ Q1: { foundryId: "Q1", modifiedTime: 2, quest: qstate("active") } });
    const plan = computePlan(m, [quest("quests/q.md", "sha256:1")], liveQ);
    expect(plan.items[0]?.action).toBe("quest-pull-progress");
  });

  it("quest-push-structure when only repo structure changed", () => {
    const ph = questProgressHash(qstate("active"));
    const m = manifest({
      "quests/q.md": { documentType: "Quest", foundryId: "Q1", contentHash: "sha256:1", remoteModifiedTime: 1, progressHash: ph, lastImportedAt: "t", assets: [] },
    });
    const liveQ = live({ Q1: { foundryId: "Q1", modifiedTime: 1, quest: qstate("active") } });
    const plan = computePlan(m, [quest("quests/q.md", "sha256:2")], liveQ);
    expect(plan.items[0]?.action).toBe("quest-push-structure");
  });

  it("quest-push-and-pull when both changed (no conflict)", () => {
    const ph = questProgressHash(qstate("inactive"));
    const m = manifest({
      "quests/q.md": { documentType: "Quest", foundryId: "Q1", contentHash: "sha256:1", remoteModifiedTime: 1, progressHash: ph, lastImportedAt: "t", assets: [] },
    });
    const liveQ = live({ Q1: { foundryId: "Q1", modifiedTime: 2, quest: qstate("completed") } });
    const plan = computePlan(m, [quest("quests/q.md", "sha256:2")], liveQ);
    expect(plan.items[0]?.action).toBe("quest-push-and-pull");
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run packages/campaign-sync/src/planner.test.ts`
Expected: PASS (10 tests total). If any quest test fails, fix `planQuest` in `planner.ts` to match.

- [ ] **Step 3: Commit**

```bash
git add packages/campaign-sync/src/planner.test.ts
git commit -m "test(campaign-sync): lock quest field-ownership planning (push structure / pull progress)"
```

---

## Task 7: Asset planning + `planToTable` rendering

**Files:**
- Modify: `packages/campaign-sync/src/planner.ts` (add `planToTable`)
- Modify: `packages/campaign-sync/src/planner.test.ts` (asset + table tests)

- [ ] **Step 1: Append the failing tests to `src/planner.test.ts`**

```ts
import { planToTable } from "./planner.js";

describe("planner — assets + rendering", () => {
  it("flags a new asset as upload and a changed asset as reupload", () => {
    const m = manifest({
      "npcs/a.md": {
        documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t",
        assets: [{ localPath: "tokens/a.webp", contentHash: "sha256:old", remotePath: "https://x/a.webp" }],
      },
    });
    const repo: RepoEntity[] = [{
      source: "npcs/a.md", documentType: "Actor", contentHash: "sha256:1",
      assets: [
        { localPath: "tokens/a.webp", contentHash: "sha256:new" },
        { localPath: "tokens/b.webp", contentHash: "sha256:b" },
      ],
    }];
    const plan = computePlan(m, repo, live({ F1: { foundryId: "F1", modifiedTime: 100 } }));
    const item = plan.items[0]!;
    expect(item.assets.find((a) => a.localPath === "tokens/a.webp")?.action).toBe("reupload");
    expect(item.assets.find((a) => a.localPath === "tokens/b.webp")?.action).toBe("upload");
  });

  it("planToTable renders one row per item", () => {
    const plan = computePlan(manifest(), [actor("npcs/a.md", "sha256:1")], live());
    const table = planToTable(plan);
    expect(table).toContain("npcs/a.md");
    expect(table).toContain("create");
  });
});
```

- [ ] **Step 2: Run to verify the asset test passes and the table test fails**

Run: `npx vitest run packages/campaign-sync/src/planner.test.ts`
Expected: asset test PASS, `planToTable` test FAIL (not exported).

- [ ] **Step 3: Add `planToTable` to `src/planner.ts`**

```ts
export function planToTable(plan: Plan): string {
  if (plan.blocked) {
    return `BLOCKED: world mismatch — manifest is for "${plan.world.id}", live world is different. No writes.`;
  }
  const rows = plan.items.map((i) => {
    const assets = i.assets.filter((a) => a.action !== "unchanged").map((a) => `${a.action}:${a.localPath}`).join(", ");
    return `| ${i.action} | ${i.documentType} | ${i.source} | ${i.reason}${assets ? ` | assets: ${assets}` : ""} |`;
  });
  return ["| action | type | source | reason |", "| --- | --- | --- | --- |", ...rows].join("\n");
}
```

Add `Plan` to the existing type import at the top of `planner.ts`:

```ts
import type { Manifest, RepoEntity, LiveState, Plan, PlanItem, AssetAction } from "./types.js";
```

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run packages/campaign-sync/src/planner.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/campaign-sync/src/planner.ts packages/campaign-sync/src/planner.test.ts
git commit -m "feat(campaign-sync): asset upload/reupload planning + plan table rendering"
```

---

## Task 8: CLI (`plan` + `record`) and repo scan

**Files:**
- Create: `packages/campaign-sync/src/scan.ts` (filesystem scan of the notes repo)
- Create: `packages/campaign-sync/src/cli.ts`
- Create: `packages/campaign-sync/src/scan.test.ts`

- [ ] **Step 1: Write the failing test `src/scan.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "./scan.js";
import { DEFAULT_TYPE_MAP } from "./notes.js";

describe("scanRepo", () => {
  it("returns a RepoEntity per classified note", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-"));
    mkdirSync(join(dir, "generated/npcs"), { recursive: true });
    writeFileSync(join(dir, "generated/npcs/a.md"), "---\nname: A\n---\nbody\n");
    const entities = scanRepo(dir, DEFAULT_TYPE_MAP);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.source).toBe("generated/npcs/a.md");
    expect(entities[0]?.documentType).toBe("Actor");
    expect(entities[0]?.contentHash).toMatch(/^sha256:/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/campaign-sync/src/scan.test.ts`
Expected: FAIL (cannot resolve `./scan.js`).

- [ ] **Step 3: Write `src/scan.ts`**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseNote, classifyType, type TypeMap } from "./notes.js";
import type { RepoEntity } from "./types.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

export function scanRepo(root: string, map: TypeMap): RepoEntity[] {
  const entities: RepoEntity[] = [];
  for (const file of walk(root)) {
    const source = relative(root, file).split(sep).join("/");
    if (!classifyType(source, map)) continue; // skip reference/unclassified files
    const note = parseNote(source, readFileSync(file, "utf8"), map);
    entities.push({
      source,
      documentType: note.documentType,
      contentHash: note.contentHash,
      assets: [], // asset linkage is resolved by the skill from front-matter; v1 scans documents only
    });
  }
  return entities;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/campaign-sync/src/scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/cli.ts`** (thin wiring; `plan` reads live-state JSON, prints table + JSON; `record` updates the manifest)

```ts
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, saveManifest } from "./manifest.js";
import { DEFAULT_TYPE_MAP } from "./notes.js";
import { scanRepo } from "./scan.js";
import { computePlan, planToTable } from "./planner.js";
import type { LiveState, Manifest } from "./types.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function cmdPlan(): void {
  const root = arg("notes", process.cwd());
  const manifestPath = resolve(arg("manifest", "foundry-sync.json"));
  const live = readJson<LiveState>(arg("live"));
  const manifest = loadManifest(manifestPath, { id: live.world.id, system: arg("system", "dnd5e"), forge: arg("forge", "true") === "true" });
  const plan = computePlan(manifest, scanRepo(root, DEFAULT_TYPE_MAP), live);
  process.stderr.write(planToTable(plan) + "\n");
  process.stdout.write(JSON.stringify(plan, null, 2));
}

function cmdRecord(): void {
  const manifestPath = resolve(arg("manifest", "foundry-sync.json"));
  // results.json: a partial Manifest["entities"] map produced by the skill after writes.
  const updates = readJson<Manifest["entities"]>(arg("results"));
  const live = readJson<LiveState>(arg("live"));
  const manifest = loadManifest(manifestPath, { id: live.world.id, system: arg("system", "dnd5e"), forge: arg("forge", "true") === "true" });
  manifest.entities = { ...manifest.entities, ...updates };
  saveManifest(manifestPath, manifest);
  process.stderr.write(`recorded ${Object.keys(updates).length} entities → ${manifestPath}\n`);
}

const cmd = process.argv[2];
if (cmd === "plan") cmdPlan();
else if (cmd === "record") cmdRecord();
else {
  process.stderr.write("usage: foundry-sync <plan|record> --live <file> [--notes dir] [--manifest path] [--results file]\n");
  process.exit(1);
}
```

- [ ] **Step 6: Smoke-test the CLI end to end**

```bash
npm run build
TMP=$(mktemp -d); mkdir -p "$TMP/generated/npcs"
printf -- '---\nname: A\n---\nbody\n' > "$TMP/generated/npcs/a.md"
printf '{"world":{"id":"w"},"docs":{}}' > "$TMP/live.json"
node packages/campaign-sync/dist/cli.js plan --notes "$TMP" --manifest "$TMP/foundry-sync.json" --live "$TMP/live.json" --system dnd5e --forge true
```

Expected: stderr prints a table row with `create | Actor | generated/npcs/a.md`; stdout prints the plan JSON with `"action": "create"`.

- [ ] **Step 7: Commit**

```bash
git add packages/campaign-sync/src/scan.ts packages/campaign-sync/src/scan.test.ts packages/campaign-sync/src/cli.ts
git commit -m "feat(campaign-sync): repo scan + plan/record CLI"
```

---

## Task 9: New `foundry-sync` skill (orchestration)

**Files:**
- Create: `examples/campaign-repo/.claude/skills/foundry-sync/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add examples/campaign-repo/.claude/skills/foundry-sync/SKILL.md
git commit -m "feat(skill): add foundry-sync reconcile skill"
```

---

## Task 10: Point `import-campaign-to-foundry` at the planner

**Files:**
- Modify: `examples/campaign-repo/.claude/skills/import-campaign-to-foundry/SKILL.md` (replace §3)
- Modify: `examples/campaign-repo/README.md` (mention the manifest + sync skill)

- [ ] **Step 1: Replace §3 "Upsert contract" with a delegation to `foundry-sync`**

Find the section beginning `## 3. Upsert contract (authoritative)` and replace its body with:

```markdown
## 3. Sync contract (authoritative)

**Don't hand-roll create-vs-update.** Reconcile through the **`foundry-sync`** skill,
which runs the deterministic `campaign-sync` planner over `foundry-sync.json` and
tells you exactly what to create / update / skip (and pulls quest progress back).
The manifest — not per-note front-matter — is the source of truth for ids, asset
paths, and drift. Run a plan before any bulk write; execute it Foundry-wins
(skip `remote-ahead`/`conflict`). See the `foundry-sync` skill for the workflow.
```

- [ ] **Step 2: Add a manifest note to `examples/campaign-repo/README.md`**

After the existing `## Notes` list, append:

```markdown
- Import state lives in a committed `foundry-sync.json` manifest (ids, asset paths,
  hashes, remote `modifiedTime`). The `foundry-sync` skill maintains it and computes
  a deterministic plan; quest progress (status + task check-offs) is pulled back into
  the quest notes' front-matter for session planning.
```

- [ ] **Step 3: Commit**

```bash
git add examples/campaign-repo/.claude/skills/import-campaign-to-foundry/SKILL.md examples/campaign-repo/README.md
git commit -m "docs(skill): delegate import upsert to the foundry-sync planner"
```

---

## Task 11: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `npm run build && npm run typecheck && npm test`
Expected: build PASS, typecheck PASS (source + `tsconfig.test.json`), all vitest suites PASS including the new `packages/campaign-sync/src/*.test.ts`.

- [ ] **Step 2: If anything fails, fix and re-run before continuing.** Do not proceed with red.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(campaign-sync): green build/typecheck/test"
```

- [ ] **Step 4: Push**

```bash
git push origin feature/forge-asset-manager-strahd
```

---

## Self-review notes (author)

- **Spec coverage:** manifest (Task 2), document classification + Foundry-wins (Task 5), quest field-ownership pull/push (Tasks 4/6), assets (Task 7), world-mismatch hard stop (Task 5), workflow + safety (Task 9), the split into a package + new skill + delegated import skill (Tasks 1/9/10), testing (every core task). FQL readability finding encoded in Task 4 + Task 9.
- **Managed-key hashing** (Task 3) prevents the pull→hash feedback loop — an implementation detail the spec implies but didn't spell out.
- **Deferred:** quest hierarchy topological ordering stays in the import skill (noted in File Structure); non-quest auto-pull is out of scope per spec §10.
```