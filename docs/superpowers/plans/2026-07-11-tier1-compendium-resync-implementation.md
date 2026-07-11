# Tier 1 Compendium-Clone Re-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `import_npc` refresh an existing Tier 1 (compendium-clone) actor in place from the current compendium on re-import — preserving Foundry-owned runtime state — instead of silently corrupting it with Tier 3 synthesis.

**Architecture:** Add a `getCompendiumDocument` read command across all protocol layers. Rebuild Tier 1 create on it (build-from-data + per-item `sourceUuid` provenance flags + a stored `tier`/`compendiumUuid` actor flag). Branch `import_npc`'s update path on the stored tier: Tier 1 → compendium-refresh (patch compendium-owned actor fields, match-and-patch items by source uuid); Tier 3 → today's synthesis-diff path unchanged. Legacy Tier 1 actors (flagged only with `statblockKey`) self-upgrade on first re-import.

**Tech Stack:** TypeScript, zod (wire protocol in `packages/shared`), vitest (mock-first integration tests in `test/integration`), esbuild bundle for the Foundry module.

**Spec:** `docs/superpowers/specs/2026-07-11-tier1-compendium-resync-design.md`

**Verification gate (per `verify-bridge` skill):** `npm run typecheck && npm test && npm run selftest`. This feature adds a protocol command, so it **also requires a Foundry module release** (bundle + the public Forge module repo). `npm test` does NOT type-check — run `npm run typecheck` after every task.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/shared/src/protocol.ts` | wire contract | add `GetCompendiumDocumentCommand` + `CompendiumDocument` result type + union entry |
| `packages/foundry-module/src/protocol-executor.ts` | executor + `FoundryDocumentApi` | dispatch case + interface method |
| `packages/foundry-module/src/foundry-runtime.ts` | real Foundry impl (not in CI) | `getCompendiumDocument` via `fromUuid` |
| `packages/foundry-module/src/relay-client.test.ts` | stub double | add stub method |
| `test/integration/mock-foundry.ts` | in-memory Foundry | dispatch case + `getCompendiumDocument` method |
| `test/integration/mock-foundry-api.ts` | mock → `FoundryDocumentApi` adapter | add delegating method |
| `packages/mcp-server/src/reliability.ts` | reliability pipeline | `getCompendiumDocumentReliable` (read) |
| `packages/mcp-server/src/tools.ts` | tool orchestration | `runGetCompendiumDocument`, wire dep, widen `findActorItems`/`findActorsByKey` return |
| `packages/statblock-sync/src/to-foundry.ts` | Tier 3 synthesis | stamp `tier: 3` on actor flag |
| `packages/statblock-sync/src/import-npc.ts` | sync layer | Tier 1 create rebuilt on data; `buildCompendiumRefreshPatch`; item match-and-patch; tier-branched update path; legacy inference |
| `packages/statblock-sync/src/import-npc.test.ts` | unit tests (new) | `buildCompendiumRefreshPatch`, item diff helpers |
| `test/integration/import-npc-tool.test.ts` | integration | Tier 1 create/refresh/legacy tests |
| `scripts/selftest.mjs` | live round-trip | M6d Tier 1 import→refresh leg |

---

## Task 1: Add `getCompendiumDocument` to the shared protocol

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/src/protocol.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/protocol.test.ts` (create the file with this content if it does not exist):

```ts
import { describe, it, expect } from "vitest";
import { Command } from "./protocol.js";

describe("GetCompendiumDocumentCommand", () => {
  it("parses a getCompendiumDocument command in the Command union", () => {
    const parsed = Command.parse({
      action: "getCompendiumDocument",
      documentType: "Actor",
      uuid: "Compendium.dnd5e.actors24.Actor.abc",
    });
    expect(parsed.action).toBe("getCompendiumDocument");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/protocol.test.ts -t "getCompendiumDocument"`
Expected: FAIL — zod rejects the unknown `action` literal (`Invalid discriminator value`).

- [ ] **Step 3: Add the command schema and result type**

In `packages/shared/src/protocol.ts`, immediately after `ImportEmbeddedFromCompendiumCommand`'s `export type` line (currently line ~282), add:

```ts
export const GetCompendiumDocumentCommand = z.object({
  action: z.literal("getCompendiumDocument"),
  /** Document type of the compendium entry (e.g. "Actor"). */
  documentType: DocumentType,
  /** UUID of the compendium entry to read (e.g. "Compendium.dnd5e.actors24.Actor.xyz"). */
  uuid: z.string().min(1),
});
export type GetCompendiumDocumentCommand = z.infer<typeof GetCompendiumDocumentCommand>;

/**
 * The full data of a compendium document, as returned by `getCompendiumDocument`.
 * Unlike `CompendiumEntry` (an index row), this carries `system` and the embedded
 * `items`, each with its own compendium `uuid` — the stable key statblock-sync
 * stamps as item provenance so a later refresh can match existing items to fresh
 * ones. Shared so the module, mock, mcp-server, and statblock-sync agree on it.
 */
export interface CompendiumDocumentItem {
  uuid: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
  effects?: Record<string, unknown>[];
}
export interface CompendiumDocument {
  uuid: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
  items: CompendiumDocumentItem[];
}
```

Then add `GetCompendiumDocumentCommand` to the `Command` discriminated union (currently line ~302), right after `ImportEmbeddedFromCompendiumCommand,`:

```ts
  ImportEmbeddedFromCompendiumCommand,
  GetCompendiumDocumentCommand,
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/protocol.test.ts -t "getCompendiumDocument"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (executor `dispatch`'s `switch` on `command.action` is now non-exhaustive — TypeScript will flag it in Task 2; if it errors here, that's expected and fixed next. If it passes because the switch has no exhaustiveness guard, proceed.)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(protocol): add getCompendiumDocument command + CompendiumDocument type"
```

---

## Task 2: Wire `getCompendiumDocument` through the executor, mock, runtime, and stubs

This is the full protocol lockstep (per the `add-foundry-command` skill). Every `FoundryDocumentApi` implementation must gain the method in this one task so `typecheck` stays green.

**Files:**
- Modify: `packages/foundry-module/src/protocol-executor.ts` (interface + dispatch)
- Modify: `test/integration/mock-foundry.ts` (dispatch + method)
- Modify: `test/integration/mock-foundry-api.ts` (delegating method)
- Modify: `packages/foundry-module/src/foundry-runtime.ts` (real method — not in CI)
- Modify: `packages/foundry-module/src/relay-client.test.ts` (stub)
- Test: `test/integration/mock-foundry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/integration/mock-foundry.test.ts`:

```ts
import { MockFoundry } from "./mock-foundry.js";
import { toApi } from "./mock-foundry-api.js";

it("getCompendiumDocument returns system + items with per-item uuids", async () => {
  const mock = new MockFoundry();
  const api = toApi(mock);
  // Gravemire Stalker is a seeded actors24 fixture with 5 items.
  const uuid = "Compendium.dnd5e.actors24.gravemire-stalker";
  const doc = await api.getCompendiumDocument("Actor", uuid);
  expect(doc.name).toBe("Gravemire Stalker");
  expect(doc.type).toBe("npc");
  expect(doc.system).toBeDefined();
  expect(doc.items.length).toBe(5);
  for (const item of doc.items) {
    expect(item.uuid.startsWith(uuid + ".Item.")).toBe(true);
    expect(typeof item.name).toBe("string");
  }
  // Deterministic: a second read yields identical item uuids (refresh matching).
  const doc2 = await api.getCompendiumDocument("Actor", uuid);
  expect(doc2.items.map((i) => i.uuid)).toEqual(doc.items.map((i) => i.uuid));
});
```

> Note the fixture uuid form: `loadFixtures` builds `Compendium.dnd5e.actors24.<fixture.id>` (the fixture `id` is `gravemire-stalker`). Confirm `toApi` is the exported adapter name in `mock-foundry-api.ts`; if it differs (e.g. `mockFoundryApi`), use that.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/mock-foundry.test.ts -t "getCompendiumDocument"`
Expected: FAIL — `api.getCompendiumDocument is not a function`.

- [ ] **Step 3: Add the interface method + dispatch case (executor)**

In `packages/foundry-module/src/protocol-executor.ts`:

Import the type — extend the existing `import { … } from "@foundry-mcp-bridge/shared"` block to include `type CompendiumDocument`.

Add to the `FoundryDocumentApi` interface, after the `importEmbeddedFromCompendium(...)` method (line ~156):

```ts
  getCompendiumDocument(
    documentType: DocumentType,
    uuid: string,
  ): Promise<CompendiumDocument>;
```

Add to the `dispatch` `switch`, after the `importEmbeddedFromCompendium` case (line ~281):

```ts
    case "getCompendiumDocument":
      return api.getCompendiumDocument(command.documentType, command.uuid);
```

- [ ] **Step 4: Implement the mock method + dispatch**

In `test/integration/mock-foundry.ts`:

Add to the executor `switch` (after the `importEmbeddedFromCompendium` case, line ~340):

```ts
      case "getCompendiumDocument":
        return this.getCompendiumDocument(id, command);
```

Add this private method next to `importEmbeddedFromCompendium` (after line ~662):

```ts
  private getCompendiumDocument(
    id: string,
    cmd: Extract<Command, { action: "getCompendiumDocument" }>,
  ): CommandResult {
    const record = this.compendium.get(cmd.uuid);
    if (!record || record.documentType !== cmd.documentType) {
      return err(id, "NOT_FOUND", `compendium entry ${cmd.uuid} not found`);
    }
    const data = structuredClone(record.data) as Record<string, any>;
    const rawItems = Array.isArray(data.items) ? (data.items as Record<string, any>[]) : [];
    const items = rawItems.map((it) => ({
      // Real compendium actor items have stable ids; the SRD fixtures omit them,
      // so derive a deterministic per-item uuid from the item name. Two reads
      // (create, then refresh) must address the same item by the same uuid.
      uuid: `${cmd.uuid}.Item.${mockItemSlug(String(it.name ?? ""))}`,
      name: String(it.name ?? ""),
      type: String(it.type ?? "feat"),
      img: it.img as string | undefined,
      system: (it.system ?? {}) as Record<string, unknown>,
      effects: Array.isArray(it.effects) ? (it.effects as Record<string, unknown>[]) : [],
    }));
    return ok(id, {
      uuid: cmd.uuid,
      name: String(data.name ?? ""),
      type: String(data.type ?? record.documentType),
      img: data.img,
      system: (data.system ?? {}) as Record<string, unknown>,
      items,
    });
  }
```

Add this module-level helper near the top of `mock-foundry.ts` (below the imports, outside the class):

```ts
/** Deterministic slug for a compendium item's synthetic uuid segment. */
function mockItemSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}
```

- [ ] **Step 5: Implement the mock-api delegating method**

In `test/integration/mock-foundry-api.ts`, extend the `type { … CompendiumEntry }` import to also import `type CompendiumDocument` from the same module, then add after the `importEmbeddedFromCompendium` method (line ~143):

```ts
    async getCompendiumDocument(documentType, uuid) {
      return (await run(
        { action: "getCompendiumDocument", documentType, uuid },
        { dryRun: false },
      )) as CompendiumDocument;
    },
```

- [ ] **Step 6: Implement the real runtime method (not in CI — live-verify later)**

In `packages/foundry-module/src/foundry-runtime.ts`, extend the shared import to include `CompendiumDocument`, and add after the `importEmbeddedFromCompendium` method (line ~451, before `} satisfies FoundryDocumentApi;`):

```ts
    async getCompendiumDocument(documentType, uuid): Promise<CompendiumDocument> {
      let source;
      try {
        source = await fromUuid(uuid);
      } catch (e) {
        throw new CommandExecutionError(
          "NOT_FOUND",
          `compendium entry ${uuid} not found`,
          { cause: e instanceof Error ? e.message : String(e) },
        );
      }
      if (!source) {
        throw new CommandExecutionError("NOT_FOUND", `compendium entry ${uuid} not found`);
      }
      const obj = source.toObject() as Record<string, any>;
      // source.items is the actor's embedded Item collection; each item's `.uuid`
      // is its full compendium uuid — the stable key statblock-sync stamps as
      // provenance and matches against on refresh.
      const items = Array.from((source.items ?? []) as Iterable<any>).map((it) => {
        const io = it.toObject() as Record<string, any>;
        return {
          uuid: it.uuid as string,
          name: it.name as string,
          type: it.type as string,
          img: io.img as string | undefined,
          system: io.system as Record<string, unknown>,
          effects: (io.effects ?? []) as Record<string, unknown>[],
        };
      });
      return {
        uuid,
        name: obj.name,
        type: obj.type,
        img: obj.img,
        system: obj.system,
        items,
      };
    },
```

- [ ] **Step 7: Implement the test stub**

In `packages/foundry-module/src/relay-client.test.ts`, add to the object returned by `stubApi()` (after `batchUploadAssets`, keeping the union satisfied):

```ts
    async getCompendiumDocument(_type, uuid) {
      return { uuid, name: "", type: "npc", system: {}, items: [] };
    },
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run test/integration/mock-foundry.test.ts -t "getCompendiumDocument"`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS (all four `satisfies FoundryDocumentApi` sites now implement the method).

- [ ] **Step 9: Commit**

```bash
git add packages/foundry-module/src/protocol-executor.ts \
  packages/foundry-module/src/foundry-runtime.ts \
  packages/foundry-module/src/relay-client.test.ts \
  test/integration/mock-foundry.ts test/integration/mock-foundry-api.ts \
  test/integration/mock-foundry.test.ts
git commit -m "feat(module): implement getCompendiumDocument in executor, mock, runtime, stub"
```

---

## Task 3: Add the reliability read + tool runner for `getCompendiumDocument`

**Files:**
- Modify: `packages/mcp-server/src/reliability.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Test: `test/integration/get-compendium-document.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/integration/get-compendium-document.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { runGetCompendiumDocument } from "../../packages/mcp-server/src/tools.js";

describe("runGetCompendiumDocument", () => {
  it("reads a compendium actor's data + items over the transport", async () => {
    const transport = new MockTransport(new MockFoundry());
    const result = await runGetCompendiumDocument(transport, {
      documentType: "Actor",
      uuid: "Compendium.dnd5e.actors24.gravemire-stalker",
    });
    expect(result.ok).toBe(true);
    const data = (result as any).data;
    expect(data.name).toBe("Gravemire Stalker");
    expect(data.items.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/get-compendium-document.test.ts`
Expected: FAIL — `runGetCompendiumDocument` is not exported.

- [ ] **Step 3: Add the reliability read helper**

In `packages/mcp-server/src/reliability.ts`, after `searchCompendiumReliable` (line ~837), add:

```ts
export interface GetCompendiumDocumentInput {
  documentType: DocumentType;
  uuid: string;
}

export function getCompendiumDocumentReliable(
  transport: RelayTransport,
  input: GetCompendiumDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runRead(
    transport,
    { action: "getCompendiumDocument", documentType: input.documentType, uuid: input.uuid },
    "get-compendium-document",
    opts,
  );
}
```

(`DocumentType` is already imported in this file; confirm and add to the import if not.)

- [ ] **Step 4: Add the tool runner**

In `packages/mcp-server/src/tools.ts`, add the import of `getCompendiumDocumentReliable` to the existing `from "./reliability.js"` import block, then add after `runImportFromCompendium` (line ~502):

```ts
// --- get_compendium_document (internal; used by import_npc) ------------------

export const GetCompendiumDocumentShape = {
  documentType: DocumentType,
  uuid: z.string().min(1),
};
const GetCompendiumDocument = z.object(GetCompendiumDocumentShape);
export type GetCompendiumDocumentArgs = z.infer<typeof GetCompendiumDocument>;

export async function runGetCompendiumDocument(
  transport: RelayTransport,
  args: GetCompendiumDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return getCompendiumDocumentReliable(transport, args, opts);
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run test/integration/get-compendium-document.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/reliability.ts packages/mcp-server/src/tools.ts \
  test/integration/get-compendium-document.test.ts
git commit -m "feat(mcp-server): add getCompendiumDocument reliability read + tool runner"
```

---

## Task 4: Stamp `tier: 3` on synthesized (Tier 3) actors

So the update-path dispatch can distinguish tiers by a stored flag. Tier 3 is the synthesis path in `to-foundry.ts`.

**Files:**
- Modify: `packages/statblock-sync/src/to-foundry.ts`
- Test: `packages/statblock-sync/src/to-foundry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/statblock-sync/src/to-foundry.test.ts`:

```ts
it("stamps tier 3 on the synthesized actor flag", () => {
  const statblock = parseStatblock(readWarrior()); // reuse the file's existing fixture loader/helper
  const actor = statblockToFoundryActor(statblock);
  expect(actor.flags?.["foundry-mcp-bridge"]?.tier).toBe(3);
});
```

> Use whatever statblock the surrounding tests already parse; match the existing helper name (e.g. an inline markdown const or a `loadFixture` call already present in this test file). The assertion is the point.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/statblock-sync/src/to-foundry.test.ts -t "tier 3"`
Expected: FAIL — `tier` is `undefined`.

- [ ] **Step 3: Add the tier stamp**

In `packages/statblock-sync/src/to-foundry.ts`, in the actor flags block (line ~281-283), add `tier: 3`:

```ts
    flags: {
      "foundry-mcp-bridge": {
        statblockKey: statblockKey(statblock.data.name),
        tier: 3,
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/statblock-sync/src/to-foundry.test.ts -t "tier 3"`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS

```bash
git add packages/statblock-sync/src/to-foundry.ts packages/statblock-sync/src/to-foundry.test.ts
git commit -m "feat(statblock-sync): stamp tier 3 on synthesized actor flag"
```

---

## Task 5: Add `buildCompendiumRefreshPatch` + Tier 1 item builders (pure helpers)

Pure functions for the refresh path, unit-tested in isolation before wiring.

**Files:**
- Modify: `packages/statblock-sync/src/import-npc.ts`
- Test: `packages/statblock-sync/src/import-npc.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/statblock-sync/src/import-npc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildCompendiumRefreshPatch,
  buildTier1ActorData,
  buildTier1Item,
} from "./import-npc.js";
import type { CompendiumDocument } from "@foundry-mcp-bridge/shared";

const fresh: CompendiumDocument = {
  uuid: "Compendium.dnd5e.actors24.Actor.arch",
  name: "Archmage",
  type: "npc",
  img: "icons/archmage.webp",
  system: {
    attributes: {
      ac: { flat: 12, calc: "natural" },
      hp: { value: 40, max: 99, temp: 5, tempmax: 0, formula: "18d8" },
      exhaustion: 2,
    },
    details: { cr: 12 },
    currency: { gp: 50 },
  },
  items: [
    { uuid: "Compendium.dnd5e.actors24.Actor.arch.Item.dagger", name: "Dagger", type: "weapon", img: "i.webp", system: { damage: 4, uses: { spent: 1 }, equipped: true } },
  ],
};

describe("buildCompendiumRefreshPatch", () => {
  it("refreshes compendium-owned fields and strips Foundry-owned runtime leaves", () => {
    const patch = buildCompendiumRefreshPatch(fresh) as any;
    expect(patch.name).toBe("Archmage");
    expect(patch.system.attributes.ac.flat).toBe(12);
    expect(patch.system.attributes.hp.max).toBe(99);
    expect(patch.system.attributes.hp.formula).toBe("18d8");
    // runtime leaves stripped so deep-merge preserves the live values:
    expect(patch.system.attributes.hp.value).toBeUndefined();
    expect(patch.system.attributes.hp.temp).toBeUndefined();
    expect(patch.system.attributes.hp.tempmax).toBeUndefined();
    expect(patch.system.attributes.exhaustion).toBeUndefined();
    expect(patch.system.currency).toBeUndefined();
    // img is only set when explicitly supplied this call:
    expect(patch.img).toBeUndefined();
  });

  it("sets img/folder only when supplied", () => {
    const patch = buildCompendiumRefreshPatch(fresh, "worlds/x.webp", "folder1") as any;
    expect(patch.img).toBe("worlds/x.webp");
    expect(patch.folder).toBe("folder1");
  });
});

describe("buildTier1Item", () => {
  it("stamps the item's sourceUuid provenance flag", () => {
    const item = buildTier1Item(fresh.items[0]!) as any;
    expect(item.name).toBe("Dagger");
    expect(item.type).toBe("weapon");
    expect(item.flags["foundry-mcp-bridge"].sourceUuid).toBe(fresh.items[0]!.uuid);
  });
});

describe("buildTier1ActorData", () => {
  it("builds an npc actor with tier/compendiumUuid flags and stamped items", () => {
    const data = buildTier1ActorData(fresh, "archmage", fresh.uuid) as any;
    expect(data.type).toBe("npc");
    expect(data.name).toBe("Archmage");
    expect(data.flags["foundry-mcp-bridge"]).toEqual({
      statblockKey: "archmage",
      tier: 1,
      compendiumUuid: fresh.uuid,
    });
    expect(data.items[0].flags["foundry-mcp-bridge"].sourceUuid).toBe(fresh.items[0]!.uuid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/statblock-sync/src/import-npc.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement the helpers**

In `packages/statblock-sync/src/import-npc.ts`, extend the shared import to include the new type:

```ts
import { isSubset, type CompendiumEntry, type CompendiumDocument, type CompendiumDocumentItem } from "@foundry-mcp-bridge/shared";
```

Add these exported helpers (place them near `buildNpcUpdatePatch`):

```ts
/**
 * Build an in-place update patch that refreshes an existing Tier 1 clone from a
 * fresh compendium document. Sends the compendium-owned `system` as a nested
 * object (Foundry's `document.update` deep-merges, so absent leaves are
 * preserved) with the Foundry-owned runtime leaves stripped: current/temp HP,
 * exhaustion, and currency. `name` is refreshed from the compendium; `img`/
 * `folder` are set only when supplied this call (a GM-set portrait survives).
 */
export function buildCompendiumRefreshPatch(
  fresh: CompendiumDocument,
  resolvedImagePath?: string,
  folderId?: string,
): Record<string, unknown> {
  const system = structuredClone(fresh.system) as Record<string, any>;
  const attributes = system.attributes as Record<string, any> | undefined;
  if (attributes?.hp) {
    delete attributes.hp.value;
    delete attributes.hp.temp;
    delete attributes.hp.tempmax;
  }
  if (attributes) delete attributes.exhaustion;
  delete system.currency;

  const patch: Record<string, unknown> = { name: fresh.name, system };
  if (resolvedImagePath) patch.img = resolvedImagePath;
  if (folderId) patch.folder = folderId;
  return patch;
}

/** Strip item-level runtime (spent uses, equipped/attunement state) so a refresh preserves it. */
function stripItemRuntime(system: Record<string, unknown>): Record<string, unknown> {
  const s = structuredClone(system) as Record<string, any>;
  if (s.uses) delete s.uses.spent;
  delete s.equipped;
  delete s.attunement;
  return s;
}

/** Build a fresh embedded item document from a compendium item, stamping our sourceUuid provenance. */
export function buildTier1Item(item: CompendiumDocumentItem): Record<string, unknown> {
  return {
    name: item.name,
    type: item.type,
    img: item.img,
    system: item.system,
    ...(item.effects && item.effects.length ? { effects: item.effects } : {}),
    flags: { "foundry-mcp-bridge": { sourceUuid: item.uuid } },
  };
}

/** Build the update patch for an already-existing Tier 1 item (runtime preserved). */
export function buildTier1ItemPatch(item: CompendiumDocumentItem): Record<string, unknown> {
  return {
    name: item.name,
    img: item.img,
    system: stripItemRuntime(item.system),
  };
}

/** Build a full Tier 1 actor document from a fresh compendium document. */
export function buildTier1ActorData(
  fresh: CompendiumDocument,
  key: string,
  compendiumUuid: string,
  folderId?: string,
  resolvedImagePath?: string,
): Record<string, unknown> {
  return {
    name: fresh.name,
    type: fresh.type,
    img: resolvedImagePath ?? fresh.img,
    system: fresh.system,
    items: fresh.items.map(buildTier1Item),
    flags: { "foundry-mcp-bridge": { statblockKey: key, tier: 1, compendiumUuid } },
    ...(folderId ? { folder: folderId } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/statblock-sync/src/import-npc.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS

```bash
git add packages/statblock-sync/src/import-npc.ts packages/statblock-sync/src/import-npc.test.ts
git commit -m "feat(statblock-sync): add Tier 1 refresh-patch + item builder helpers"
```

---

## Task 6: Add the `getCompendiumDocument` dep + item-refresh function; rebuild Tier 1 create

**Files:**
- Modify: `packages/statblock-sync/src/import-npc.ts` (deps interface, create path, `refreshCompendiumItems`)
- Modify: `packages/mcp-server/src/tools.ts` (wire dep; widen `findActorItems`/`findActorsByKey`)

- [ ] **Step 1: Extend `ImportNpcDeps` and widen the item/match shapes**

In `packages/statblock-sync/src/import-npc.ts`, in `ImportNpcDeps`:

Add the read dep:

```ts
  /** Read a compendium document's full data (system + items with per-item uuids). */
  getCompendiumDocument(uuid: string): Promise<CompendiumDocument>;
```

Change `findActorsByKey` to carry the actor's flags (needed for tier dispatch):

```ts
  /** Find actors by their statblockKey flag, returning each actor's flags for tier dispatch. */
  findActorsByKey(key: string): Promise<Array<{ _id: string; flags?: Record<string, any> }>>;
```

Widen `findActorItems`' item type to include `_stats` (for legacy adoption):

```ts
  findActorItems(actorId: string): Promise<Array<{ _id: string; name: string; type: string; img?: string; system?: any; flags?: Record<string, any>; _stats?: Record<string, any> }>>;
```

Remove the now-unused `importFromCompendium` dep from `ImportNpcDeps` (Tier 1 create no longer calls it). The general `import_from_compendium` tool is untouched — only this internal dep is removed.

- [ ] **Step 2: Rebuild the Tier 1 create branch**

In `importNpc`'s CREATE PATH (currently lines ~163-199), replace the `if (plan.tier === 1) { … }` block with:

```ts
    if (plan.tier === 1) {
      const fresh = await deps.getCompendiumDocument(plan.uuid);
      const resolvedImagePath = await resolveImagePath(statblock, imageContent, deps);
      const actorData = buildTier1ActorData(fresh, key, plan.uuid, folderId, resolvedImagePath);
      const doc = await deps.createDocument(actorData as Dnd5eActorDocument);
      actorId = doc._id;
      action = "created";
      result = { actorId, tier: 1, matchedUuid: plan.uuid, action };
      // Tier 1 spells are compendium items already present in `fresh.items`;
      // do NOT run attachSpells (it would duplicate them from the note's list).
      return result;
    }
```

> This early-returns, so the trailing `await attachSpellsTagged(statblock, actorId, deps)` (line ~201) now runs only for the Tier 3 create branch — which is correct.

- [ ] **Step 3: Add `refreshCompendiumItems`**

Add this function to `import-npc.ts` (near `diffAndApplyItems`):

```ts
/**
 * Match-and-patch an existing Tier 1 clone's items against a fresh compendium
 * document, keyed by our `sourceUuid` provenance flag. Matched items are updated
 * in place (preserving `_id` and item-level runtime), new compendium items are
 * created, removed ones deleted, and GM-added (unflagged, un-adoptable) items
 * left untouched.
 *
 * Legacy adoption: an actor cloned before provenance stamping has unflagged
 * items. Each is adopted to a fresh item by matching `_stats.compendiumSource`
 * (real Foundry stamps it on clone) or, failing that, by exact name — so the
 * first re-import upgrades in place instead of duplicating the whole item set.
 */
async function refreshCompendiumItems(
  actorId: string,
  fresh: CompendiumDocument,
  deps: ImportNpcDeps,
): Promise<{ created: number; updated: number; deleted: number; unchanged: number }> {
  const currentItems = await deps.findActorItems(actorId);
  const freshByUuid = new Map(fresh.items.map((i) => [i.uuid, i]));
  const claimed = new Map<string, { _id: string; name: string; img?: string; system?: any; hadFlag: boolean }>();

  // First, items already carrying our sourceUuid flag.
  for (const it of currentItems) {
    const src = it.flags?.["foundry-mcp-bridge"]?.sourceUuid;
    if (typeof src === "string" && !claimed.has(src)) {
      claimed.set(src, { _id: it._id, name: it.name, img: it.img, system: it.system, hadFlag: true });
    }
  }
  // Then adopt legacy unflagged items to a fresh uuid by compendiumSource or name.
  for (const it of currentItems) {
    if (it.flags?.["foundry-mcp-bridge"]?.sourceUuid) continue;
    const bySource = it._stats?.compendiumSource;
    let matchUuid: string | undefined;
    if (typeof bySource === "string" && freshByUuid.has(bySource) && !claimed.has(bySource)) {
      matchUuid = bySource;
    } else {
      for (const [uuid, f] of freshByUuid) {
        if (!claimed.has(uuid) && f.name === it.name) { matchUuid = uuid; break; }
      }
    }
    if (matchUuid) {
      claimed.set(matchUuid, { _id: it._id, name: it.name, img: it.img, system: it.system, hadFlag: false });
    }
  }

  let created = 0, updated = 0, deleted = 0, unchanged = 0;

  // Create fresh items with no claimed counterpart.
  for (const [uuid, item] of freshByUuid) {
    if (claimed.has(uuid)) continue;
    await deps.createEmbeddedItem(actorId, buildTier1Item(item));
    created++;
  }

  // Update (or adopt+stamp) claimed items.
  for (const [uuid, current] of claimed) {
    const item = freshByUuid.get(uuid)!;
    const patch = buildTier1ItemPatch(item) as Record<string, any>;
    // Legacy items must be stamped with our flag as part of the upgrade.
    if (!current.hadFlag) {
      patch.flags = { "foundry-mcp-bridge": { sourceUuid: uuid } };
    }
    const changed =
      current.hadFlag === false ||
      current.name !== item.name ||
      current.img !== item.img ||
      !isSubset(current.system, patch.system);
    if (changed) {
      await deps.updateEmbeddedItem(actorId, current._id, patch);
      updated++;
    } else {
      unchanged++;
    }
  }

  // Delete flagged items whose source disappeared from the compendium.
  for (const it of currentItems) {
    const src = it.flags?.["foundry-mcp-bridge"]?.sourceUuid;
    if (typeof src === "string" && !freshByUuid.has(src)) {
      await deps.deleteEmbeddedItem(actorId, it._id);
      deleted++;
    }
  }

  return { created, updated, deleted, unchanged };
}
```

- [ ] **Step 4: Wire the dep + widen shapes in tools.ts**

In `packages/mcp-server/src/tools.ts`, in `runImportNpc`'s `deps` object:

Remove the `importFromCompendium` dep method (lines ~686-697) — no longer part of `ImportNpcDeps`.

Add the new dep (near `searchCompendium`):

```ts
      async getCompendiumDocument(uuid: string): Promise<CompendiumDocument> {
        const result = await runGetCompendiumDocument(transport, { documentType: "Actor", uuid });
        return unwrapDep("getCompendiumDocument", result);
      },
```

Widen `findActorsByKey` to project flags:

```ts
      async findActorsByKey(key: string): Promise<Array<{ _id: string; flags?: Record<string, any> }>> {
        const result = await runFindDocuments(transport, {
          documentType: "Actor",
          query: { "flags.foundry-mcp-bridge.statblockKey": key },
          fields: ["_id", "flags"],
        });
        return unwrapDep("findActorsByKey", result);
      },
```

> Confirm `runFindDocuments` with a `query` returns matched docs including projected `fields`. If `fields` isn't honored on multi-doc finds, drop it — `unwrapDep` returns whatever the find yields, and the actor docs already carry `flags`.

Ensure `CompendiumDocument` is imported in `tools.ts` (from `@foundry-mcp-bridge/shared`). The `findActorItems` dep already returns `actor.items` verbatim, so `_stats` passes through — only its TS type widened (Task 6 Step 1).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If the test doubles in `import-npc.test.ts` or integration mocks construct `ImportNpcDeps` inline, they inherit the new method requirement — integration tests go through `runImportNpc`, which supplies the real dep, so no change needed there.)

- [ ] **Step 6: Run the existing suite (no behavior regression yet on Tier 3)**

Run: `npm test`
Expected: PASS — Tier 3 create/upsert tests unchanged; Tier 1 create now builds-from-data (covered end-to-end in Task 8).

- [ ] **Step 7: Commit**

```bash
git add packages/statblock-sync/src/import-npc.ts packages/mcp-server/src/tools.ts
git commit -m "feat(statblock-sync): rebuild Tier 1 create on getCompendiumDocument; add item refresh"
```

---

## Task 7: Branch the update path on tier (Tier 1 refresh + legacy inference)

**Files:**
- Modify: `packages/statblock-sync/src/import-npc.ts`

- [ ] **Step 1: Add the tier resolver + Tier 1 refresh orchestrator**

In `import-npc.ts`, add:

```ts
/**
 * Resolve a matched actor's tier for the update path. Prefers the stored
 * `tier` flag; for legacy actors (flagged only with statblockKey) infers it by
 * re-running compendium matching — an exact name match means it is a Tier 1
 * clone. Returns the compendium uuid too when Tier 1 (stored, or re-derived).
 */
async function resolveMatchedTier(
  matched: { _id: string; flags?: Record<string, any> },
  statblock: StatblockData,
  deps: ImportNpcDeps,
): Promise<{ tier: 1; compendiumUuid: string } | { tier: 3 }> {
  const flag = matched.flags?.["foundry-mcp-bridge"];
  if (flag?.tier === 3) return { tier: 3 };
  if (flag?.tier === 1 && typeof flag.compendiumUuid === "string") {
    return { tier: 1, compendiumUuid: flag.compendiumUuid };
  }
  // Legacy (no tier flag): infer via compendium exact-match.
  const index = await deps.searchCompendium(statblock.data.name);
  const plan = matchStatblock(statblock, index);
  return plan.tier === 1 ? { tier: 1, compendiumUuid: plan.uuid } : { tier: 3 };
}

/** Refresh an existing Tier 1 clone in place from its compendium source. */
async function refreshTier1(
  actorId: string,
  compendiumUuid: string,
  statblock: StatblockData,
  deps: ImportNpcDeps,
  imageContent: { filename: string; contentBase64: string } | undefined,
  folderId: string | undefined,
): Promise<ImportNpcResult> {
  let fresh: CompendiumDocument;
  try {
    fresh = await deps.getCompendiumDocument(compendiumUuid);
  } catch (e) {
    throw Object.assign(
      new Error(`Tier 1 refresh: compendium document ${compendiumUuid} could not be read`),
      { code: "VALIDATION", details: { compendiumUuid }, stage: "compendium-read", actorId },
    );
  }

  try {
    const resolvedImagePath = await resolveImagePath(statblock, imageContent, deps);
    const patch = buildCompendiumRefreshPatch(fresh, resolvedImagePath, folderId);
    // Backfill tier/compendiumUuid for legacy actors on this upgrade pass.
    (patch as any)["flags.foundry-mcp-bridge.tier"] = 1;
    (patch as any)["flags.foundry-mcp-bridge.compendiumUuid"] = compendiumUuid;
    await deps.updateDocument(actorId, patch);
  } catch (e) {
    const err = e as any;
    if (!err.stage) err.stage = "actor-update";
    if (!("actorId" in err)) err.actorId = actorId;
    throw err;
  }

  let itemChanges;
  try {
    itemChanges = await refreshCompendiumItems(actorId, fresh, deps);
  } catch (e) {
    const err = e as any;
    err.actorId = actorId;
    err.stage = "itemDiff";
    throw err;
  }

  return { actorId, tier: 1, matchedUuid: compendiumUuid, action: "updated", itemChanges };
}
```

> The flag backfill uses dot-notation keys alongside the nested `system` patch — `applyUpdate`/Foundry both expand dot keys and deep-merge, so `statblockKey` (a sibling leaf) is untouched.

- [ ] **Step 2: Capture the matched actor object and branch the update path**

In `importNpc`, change the match-query block so it retains the matched actor (not just the id). Where it currently does:

```ts
    if (matches.length === 1) {
      matchedActorId = matches[0]!._id;
    }
```

introduce a `matchedActor` in the function scope:

```ts
  let matchedActor: { _id: string; flags?: Record<string, any> } | undefined;
```

and set it in the single-match branch:

```ts
    if (matches.length === 1) {
      matchedActor = matches[0]!;
      matchedActorId = matchedActor._id;
    }
```

Then, at the top of the UPDATE PATH (`if (matchedActorId && (mode === "upsert" || mode === "update")) {`), before the existing Tier 3 logic, add the tier branch:

```ts
  if (matchedActorId && (mode === "upsert" || mode === "update")) {
    // matchedActor is set whenever we matched by key here; when a caller passes
    // matchedActorId explicitly without flags, fall back to Tier 3 (today's behavior).
    if (matchedActor) {
      const resolved = await resolveMatchedTier(matchedActor, statblock, deps);
      if (resolved.tier === 1) {
        return await refreshTier1(
          matchedActorId,
          resolved.compendiumUuid,
          statblock,
          deps,
          imageContent,
          folderId,
        );
      }
    }
    // Tier 3 → existing synthesis-diff path (unchanged below).
    try {
      const resolvedImagePath = await resolveImagePath(statblock, imageContent, deps);
      ...
```

(Leave the entire existing Tier 3 update body as-is after this point.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS — no Tier 3 regression. Tier 1 refresh behavior is asserted in Task 8.

- [ ] **Step 5: Commit**

```bash
git add packages/statblock-sync/src/import-npc.ts
git commit -m "feat(statblock-sync): branch import_npc update path on tier; Tier 1 refresh + legacy inference"
```

---

## Task 8: Integration tests — Tier 1 create, refresh, legacy upgrade

Drive the whole feature through `runImportNpc` against `MockFoundry`. Requires a statblock note whose exact name matches a seeded compendium actor. `Gravemire Stalker` is seeded in `actors24`.

**Files:**
- Create: `test/fixtures/statblock-import/gravemire-stalker.md` (a note named exactly "Gravemire Stalker")
- Modify: `test/integration/import-npc-tool.test.ts`

- [ ] **Step 1: Create the Tier 1 note fixture**

Create `test/fixtures/statblock-import/gravemire-stalker.md`. Model its structure on the existing `simple-warrior.md` fixture (open it first for the exact statblock grammar the parser+lint accept), but with `name: Gravemire Stalker` so `matchStatblock` promotes it to Tier 1. The mechanical values in the note are irrelevant to a Tier 1 refresh (the compendium wins) but must lint clean.

- [ ] **Step 2: Write the failing tests**

Add to `test/integration/import-npc-tool.test.ts`:

```ts
describe("Tier 1 (compendium-clone) resync", () => {
  const tier1Note = () => loadFixture("gravemire-stalker.md");

  it("first import creates a Tier 1 clone with tier + item provenance flags", async () => {
    const result = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    expect(result.ok).toBe(true);
    const { actorId, tier, action } = (result as any).data;
    expect(tier).toBe(1);
    expect(action).toBe("created");

    const actor = mock.documents("Actor").find((a: any) => a._id === actorId)!;
    expect(actor.flags["foundry-mcp-bridge"].tier).toBe(1);
    expect(actor.flags["foundry-mcp-bridge"].compendiumUuid).toContain("gravemire-stalker");
    expect(actor.items.length).toBe(5);
    for (const it of actor.items) {
      expect(it.flags["foundry-mcp-bridge"].sourceUuid).toBeTruthy();
    }
  });

  it("re-import refreshes in place, preserving _id and Foundry-owned runtime", async () => {
    const first = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    const actorId = (first as any).data.actorId;

    // Inject runtime state a refresh must preserve.
    const actor = mock.documents("Actor").find((a: any) => a._id === actorId)!;
    actor.system.attributes.hp.value = 3;
    actor.system.currency = { gp: 999 };

    const second = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    expect(second.ok).toBe(true);
    const data = (second as any).data;
    expect(data.action).toBe("updated");
    expect(data.tier).toBe(1);
    expect(data.actorId).toBe(actorId); // same _id
    expect(data.itemChanges.created).toBe(0);
    expect(data.itemChanges.deleted).toBe(0);

    const after = mock.documents("Actor").find((a: any) => a._id === actorId)!;
    expect(after.system.attributes.hp.value).toBe(3);   // runtime preserved
    expect(after.system.currency.gp).toBe(999);          // runtime preserved
    expect(after.items.length).toBe(5);                  // no duplication
  });

  it("refresh reflects a changed/added/removed compendium item; GM-added item survives", async () => {
    const first = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    const actorId = (first as any).data.actorId;

    // GM adds an unflagged item — must be preserved untouched.
    const actor = mock.documents("Actor").find((a: any) => a._id === actorId)!;
    actor.items.push({ _id: "gm-item", name: "GM Trinket", type: "loot", system: {} });

    // Mutate the seeded compendium: rename one item, drop another.
    const uuid = (first as any).data.matchedUuid;
    const record = (mock as any).compendium.get(uuid);
    record.data.items[0].name = "Undead Fortitude (Revised)";
    record.data.items.pop();

    const second = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    const data = (second as any).data;
    expect(data.itemChanges.deleted).toBe(1);

    const after = mock.documents("Actor").find((a: any) => a._id === actorId)!;
    expect(after.items.some((i: any) => i.name === "GM Trinket")).toBe(true); // preserved
  });

  it("legacy Tier 1 actor (statblockKey only) self-upgrades on re-import without duplicating items", async () => {
    // Seed a legacy clone: flagged with statblockKey but no tier/compendiumUuid,
    // items unflagged (as the old importFromCompendium path produced).
    const uuid = "Compendium.dnd5e.actors24.gravemire-stalker";
    const rec = (mock as any).compendium.get(uuid);
    const legacy = {
      ...structuredClone(rec.data),
      _id: "legacy-1",
      flags: { "foundry-mcp-bridge": { statblockKey: "gravemire-stalker" } },
    };
    (mock as any).store.set("Actor:legacy-1" /* use mock's documentKey form */, legacy);

    const result = await runImportNpc(transport, { markdown: tier1Note(), assetSource: "data" });
    const data = (result as any).data;
    expect(data.action).toBe("updated");
    expect(data.actorId).toBe("legacy-1");

    const after = mock.documents("Actor").find((a: any) => a._id === "legacy-1")!;
    expect(after.flags["foundry-mcp-bridge"].tier).toBe(1);
    expect(after.items.length).toBe(5); // adopted, not duplicated to 10
    expect(after.items.every((i: any) => i.flags?.["foundry-mcp-bridge"]?.sourceUuid)).toBe(true);
  });
});
```

> The legacy test seeds the store directly. Check `mock-foundry.ts` for the exact `documentKey(type, id)` form (it's `` `${type}:${id}` `` or similar) and the accessor for the compendium/store maps; adjust the `store.set` key and `mock.documents(...)`/`compendium.get(...)` access to match the mock's real API (they may be private — if so, add a tiny test helper on `MockFoundry` like `seedActor(data)` rather than reaching into internals).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/integration/import-npc-tool.test.ts -t "Tier 1"`
Expected: FAIL initially if fixture/grammar needs adjusting; iterate on the fixture and any mock seed-helper until these pass. They exercise code already implemented in Tasks 5-7, so failures here are about test setup (fixture grammar, mock seeding), not missing logic.

- [ ] **Step 4: Make them pass**

Adjust the `gravemire-stalker.md` fixture grammar (run `npm run lint:statblock -- test/fixtures/statblock-import/gravemire-stalker.md` to confirm it lints clean) and the mock seeding helper until green.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/statblock-import/gravemire-stalker.md test/integration/import-npc-tool.test.ts
git commit -m "test(import-npc): Tier 1 create/refresh/legacy-upgrade integration coverage"
```

---

## Task 9: Selftest leg + module bundle (live round-trip)

**Files:**
- Modify: `scripts/selftest.mjs`

- [ ] **Step 1: Add the M6d Tier 1 leg**

In `scripts/selftest.mjs`, after the M6c re-import block (line ~455-490), add an M6d leg that imports a note whose name **exactly matches a monster in the live world's dnd5e compendium** (e.g. a real SRD name — confirm one present in the target world; `Gravemire Stalker` is a test-only fixture and will NOT exist live, so pick a real SRD monster and add a matching note fixture, or reuse an existing one). Pattern:

```js
      // M6d: Tier 1 compendium-clone import + idempotent refresh
      console.log("\n  M6d: Tier 1 compendium clone import + refresh");
      const tier1Md = fs.readFileSync("test/fixtures/statblock-import/<real-srd-monster>.md", "utf-8");
      const t1a = await runImportNpc(server, { markdown: tier1Md, assetSource: SOURCE });
      if (!t1a.ok) throw new Error(`M6d import failed: ${t1a.error.code}`);
      if (t1a.data.tier !== 1) throw new Error(`M6d: expected tier 1, got ${t1a.data.tier}`);
      console.log(`    ✓ Tier 1 actor ${t1a.data.actorId} cloned from ${t1a.data.matchedUuid}`);

      const t1b = await runImportNpc(server, { markdown: tier1Md, assetSource: SOURCE });
      if (!t1b.ok) throw new Error(`M6d refresh failed: ${t1b.error.code}`);
      if (t1b.data.action !== "updated") throw new Error(`M6d: expected "updated", got "${t1b.data.action}"`);
      if (t1b.data.actorId !== t1a.data.actorId) throw new Error(`M6d: actor _id changed on refresh`);
      const d = t1b.data.itemChanges;
      if (d.created !== 0 || d.deleted !== 0) throw new Error(`M6d: unexpected item deltas ${JSON.stringify(d)}`);
      console.log(`    ✓ refresh idempotent: same actor, 0 item deltas`);
```

Match the surrounding leg's variable names (`server`, `SOURCE`, cleanup) exactly — read M6b/M6c first.

- [ ] **Step 2: Build the module bundle**

Run: `npm run bundle:module`
Expected: builds `packages/foundry-module/dist/index.js` with no errors (the new `getCompendiumDocument` runtime path is included).

- [ ] **Step 3: Run the full gate (mock legs always run; live legs need Foundry connected)**

Run: `npm run selftest`
Expected: M6a-M6c pass; M6d passes when a live Foundry world with the matching SRD monster is connected (per memory `forge-live-test-setup`). If no live world is connected, the selftest's mock/offline legs still validate; the M6d live assertion is the **required live-verify** for this feature.

- [ ] **Step 4: Commit**

```bash
git add scripts/selftest.mjs
git commit -m "test(selftest): add M6d Tier 1 clone import + refresh leg"
```

---

## Task 10: Live-verify + release (per memory `live-forge-check-after-module-changes`)

`foundry-runtime.ts` and build-from-data item **active effects** are not exercised by CI. Before calling this done:

- [ ] **Step 1: Install the module into the live world**

Run: `npm run install:foundry`
(Or `npm run bundle:module` and load the dist into the connected Forge/local world.)

- [ ] **Step 2: Live-verify Tier 1 create**

Import a real SRD monster note via `import_npc` against the live world. Confirm: `tier: 1`; the actor has working, effect-bearing items (build-from-data preserved active effects); actor + item flags present.

- [ ] **Step 3: Live-verify refresh**

Set some runtime state on the actor (spend HP, add a temp effect), re-import the same note. Confirm: same actor `_id`, runtime preserved, 0 spurious item deltas, no duplicated items.

- [ ] **Step 4: Release the module**

Publish the module release (bundle + the public Forge module repo `whelan/foundry-mcp-bridge-module` manifest) since this adds a protocol command the module must serve. Follow the project's existing release process.

- [ ] **Step 5: Final gate**

Run: `npm run typecheck && npm test && npm run selftest`
Expected: all PASS.

---

## Self-Review

**Spec coverage:**
- §1 dispatch fix (store tier, branch) → Tasks 4, 7. ✓
- §2 `getCompendiumDocument` command + module release → Tasks 1-3, 9, 10. ✓
- §3 Tier 1 create rebuilt on data + provenance → Tasks 5, 6. ✓
- §4 in-place refresh, actor ownership table + item match-and-patch → Tasks 5, 6, 7. ✓
- §5 legacy self-upgrade → Tasks 6 (adoption), 7 (inference), 8 (test). ✓
- §6 API/output/errors (`tier:1` refresh output, missing-uuid error) → Task 7 (`refreshTier1` throws VALIDATION w/ `compendiumUuid`), output already carries fields (tools.ts unchanged for output shape). ✓
- §7 testing + mock-fidelity gate → Tasks 8, 9, 10. ✓

**Type consistency:** `CompendiumDocument`/`CompendiumDocumentItem` (Task 1) used identically in executor/mock/runtime (Task 2), deps + helpers (Tasks 5-7). `sourceUuid` provenance flag key consistent across `buildTier1Item`, `refreshCompendiumItems`, tests. `findActorsByKey` return-shape widened once (Task 6) and consumed in Task 7.

**Known follow-through flagged for the implementer (not placeholders — real environment coupling):** the exact mock store/compendium accessor forms in Task 8 and the real SRD monster name for the live/selftest legs (Tasks 9-10) must be confirmed against the actual mock API and the connected world — each step says so explicitly.
