import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "@foundry-mcp-bridge/shared";
import type { Command, CommandError } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";
import {
  runCreateDocument,
  runCreateScene,
  runUpdateDocument,
  runDuplicateDocument,
  runFindDocuments,
  runGetWorldInfo,
  runUploadAsset,
  runBrowseAssets,
  runBatchUploadAssets,
  runCreateEmbedded,
  runUpdateEmbedded,
  runDeleteEmbedded,
  runCreateQuest,
  runUpdateQuest,
  runSearchCompendium,
  runImportFromCompendium,
} from "../../packages/mcp-server/src/tools.js";

function setup() {
  const mock = new MockFoundry();
  const transport = new MockTransport(mock);
  return { mock, transport };
}

/** Assert a tool failed with a specific error code (and narrow the union). */
function expectErr(out: ToolOutcome, code: CommandError["code"]): void {
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error.code).toBe(code);
}

/** Run a command directly against the mock to seed state (bypasses the pipeline). */
function seed(mock: MockFoundry, command: Command): Promise<unknown> {
  return mock.execute({ id: "seed", protocolVersion: PROTOCOL_VERSION, dryRun: false, command });
}

function seedScene(mock: MockFoundry): Promise<unknown> {
  return seed(mock, { action: "create", documentType: "Scene", data: { _id: "s1", name: "Map" }, keepId: true });
}

async function seedSceneWithToken(mock: MockFoundry): Promise<void> {
  await seedScene(mock);
  await seed(mock, {
    action: "createEmbedded",
    parentType: "Scene",
    parentId: "s1",
    embeddedName: "Token",
    data: [{ _id: "t1", name: "Goblin", x: 0 }],
  });
}

describe("create_document pipeline", () => {
  it("validates, writes and reads back an Actor", async () => {
    const { mock, transport } = setup();
    const out = await runCreateDocument(transport, {
      documentType: "Actor",
      data: { name: "Bob", type: "npc" },
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write", "read-back"]);
    expect(mock.documents("Actor").length).toBe(1);
  });

  it("slims the write echo by default (no full document in context)", async () => {
    const { transport } = setup();
    const out = await runCreateDocument(transport, {
      documentType: "Actor",
      data: { name: "Bob", type: "npc", system: { big: "payload".repeat(50) } },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      // Assert presence of the identifying keys + absence of the bulky block —
      // not exact keys, since _stats.modifiedTime is included when present.
      const data = out.data as Record<string, unknown>;
      expect(data._id).toBeDefined();
      expect(data.name).toBe("Bob");
      expect(data.system).toBeUndefined();
      expect(JSON.stringify(out.data)).not.toContain("payload");
    }
  });

  it("honours an explicit fields list on the write echo", async () => {
    const { transport } = setup();
    const out = await runCreateDocument(transport, {
      documentType: "Actor",
      data: { name: "Bob", type: "npc" },
      fields: ["_id"],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(Object.keys(out.data as object)).toEqual(["_id"]);
  });

  it("returns the whole document when full=true (opt-out)", async () => {
    const { transport } = setup();
    const out = await runCreateDocument(transport, {
      documentType: "Actor",
      data: { name: "Bob", type: "npc", system: { big: "payload" } },
      full: true,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.data as { system: unknown }).system).toEqual({ big: "payload" });
  });

  it("preserves an explicit _id when keepId is set", async () => {
    const { mock, transport } = setup();
    const out = await runCreateDocument(transport, {
      documentType: "JournalEntry",
      data: { _id: "UbHNCnZu4BEtnAmI", name: "Spare Bedroom" },
      keepId: true,
    });
    expect(out.ok).toBe(true);
    expect(mock.store.has("!journal!UbHNCnZu4BEtnAmI")).toBe(true);
  });

  it("rolls back when read-back does not match", async () => {
    const { mock, transport } = setup();
    transport.corruptReadBack = true;
    const out = await runCreateDocument(transport, {
      documentType: "Actor",
      data: { name: "Bob" },
    });
    expectErr(out, "READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // The created document was deleted by the rollback.
    expect(mock.documents("Actor").length).toBe(0);
  });

  it("surfaces a TIMEOUT as a structured error", async () => {
    const { mock, transport } = setup();
    mock.hangNext(50);
    const out = await runCreateDocument(
      transport,
      { documentType: "Actor", data: { name: "Slow" } },
      { timeoutMs: 10 },
    );
    expectErr(out, "TIMEOUT");
  });

  it("rejects an empty data instead of a vacuously-verified create", async () => {
    // Regression test: create's data isn't run through filterUnsafePaths, so
    // an empty object can only be the caller's own doing. A document created
    // from nothing has no name/type of its own for nameOrTypeFallback to
    // check either, so unlike duplicate/import there's no weaker fallback
    // available -- an empty create must be rejected outright, or read-back
    // verification would trivially "pass" no matter what came back.
    const { mock, transport } = setup();
    transport.corruptReadBack = true; // would otherwise be masked by the vacuous check
    const out = await runCreateDocument(transport, { documentType: "Actor", data: {} });
    expectErr(out, "VALIDATION");
    expect(mock.documents("Actor").length).toBe(0);
  });
});

describe("create_scene pipeline", () => {
  it("builds a V14 scene and persists it", async () => {
    const { mock, transport } = setup();
    const out = await runCreateScene(transport, { name: "Tavern", gridSize: 70 });
    expect(out.ok).toBe(true);
    const scene = mock.documents("Scene")[0] as { name: string; grid: { size: number } };
    expect(scene.name).toBe("Tavern");
    expect(scene.grid.size).toBe(70);
  });
});

describe("update_document pipeline", () => {
  it("updates with dot-notation and verifies the change", async () => {
    const { mock, transport } = setup();
    await seed(mock, {
      action: "create",
      documentType: "Actor",
      data: { _id: "a1", name: "Bob", system: { hp: { value: 1 } } },
      keepId: true,
    });
    const out = await runUpdateDocument(transport, {
      documentType: "Actor",
      id: "a1",
      data: { "system.hp.value": 9 },
    });
    expect(out.ok).toBe(true);
    const actor = mock.documents("Actor")[0] as { system: { hp: { value: number } } };
    expect(actor.system.hp.value).toBe(9);
  });

  it("returns NOT_FOUND for a missing document", async () => {
    const { transport } = setup();
    const out = await runUpdateDocument(transport, {
      documentType: "Actor",
      id: "ghost",
      data: { name: "x" },
    });
    expectErr(out, "NOT_FOUND");
  });

  it("drops unsafe dot-path keys from the diff before it reaches the runtime", async () => {
    const { mock, transport } = setup();
    await seed(mock, {
      action: "create",
      documentType: "Actor",
      data: { _id: "a1", name: "Bob" },
      keepId: true,
    });
    const out = await runUpdateDocument(transport, {
      documentType: "Actor",
      id: "a1",
      data: { name: "Renamed", "__proto__.polluted": "x", "a..b": 1 },
    });
    expect(out.ok).toBe(true);
    const actor = mock.documents("Actor")[0] as { name: string };
    expect(actor.name).toBe("Renamed"); // safe key applied
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // unsafe key never sent
  });

  it("rejects a diff with no safe fields instead of silently no-op succeeding", async () => {
    // Regression test: if every key is stripped as unsafe (or the diff was
    // empty to begin with), the write is a no-op and read-back trivially
    // "verifies" it -- reporting success while discarding the caller's
    // actual intent. This must fail loudly instead.
    const { mock, transport } = setup();
    await seed(mock, {
      action: "create",
      documentType: "Actor",
      data: { _id: "a1", name: "Bob" },
      keepId: true,
    });
    const out = await runUpdateDocument(transport, {
      documentType: "Actor",
      id: "a1",
      data: { "__proto__.polluted": "x" },
    });
    expectErr(out, "VALIDATION");
    const actor = mock.documents("Actor")[0] as { name: string };
    expect(actor.name).toBe("Bob"); // untouched
  });
});

describe("find_documents projection", () => {
  const seedActor = (mock: MockFoundry, id: string, name: string) =>
    seed(mock, {
      action: "create",
      documentType: "Actor",
      keepId: true,
      data: {
        _id: id,
        name,
        system: { attributes: { hp: { value: 42, max: 50 } } },
        _stats: { modifiedTime: 1234 },
      },
    });

  it("projects a single document to only the requested dot-paths", async () => {
    const { mock, transport } = setup();
    await seedActor(mock, "a1", "Strahd");
    const out = await runFindDocuments(transport, {
      documentType: "Actor",
      id: "a1",
      fields: ["_id", "_stats.modifiedTime"],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data).toEqual({ _id: "a1", _stats: { modifiedTime: 1234 } });
  });

  it("projects every doc in a query result, dropping bulky fields", async () => {
    const { mock, transport } = setup();
    await seedActor(mock, "a1", "Strahd");
    await seedActor(mock, "a2", "Ireena");
    const out = await runFindDocuments(transport, {
      documentType: "Actor",
      query: {},
      fields: ["_id", "name"],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toEqual([
        { _id: "a1", name: "Strahd" },
        { _id: "a2", name: "Ireena" },
      ]);
      // The heavy system data never reaches the caller.
      expect(JSON.stringify(out.data)).not.toContain("attributes");
    }
  });

  it("returns whole documents when no fields are given (back-compat)", async () => {
    const { mock, transport } = setup();
    await seedActor(mock, "a1", "Strahd");
    const out = await runFindDocuments(transport, { documentType: "Actor", id: "a1" });
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.data as { system: unknown }).system).toBeDefined();
  });

  it("ignores prototype-chain field paths (no pollution, no inherited reads)", async () => {
    const { mock, transport } = setup();
    await seedActor(mock, "a1", "Strahd");
    const out = await runFindDocuments(transport, {
      documentType: "Actor",
      id: "a1",
      fields: ["_id", "__proto__.polluted", "constructor.prototype.x"],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data).toEqual({ _id: "a1" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("get_world_info", () => {
  it("returns the world snapshot for import planning", async () => {
    const mock = new MockFoundry({
      worldInfo: {
        system: { id: "dnd5e", version: "3.3.1" },
        folders: [{ _id: "f1", name: "NPCs", type: "Actor" }],
      },
    });
    const transport = new MockTransport(mock);
    const out = await runGetWorldInfo(transport);
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["get-world-info"]);
    const info = out.ok ? (out.data as any) : null;
    expect(info.system.id).toBe("dnd5e");
    expect(info.folders).toEqual([{ _id: "f1", name: "NPCs", type: "Actor" }]);
    // forge detection defaults to off locally; clients read this to pick the asset source.
    expect(info.forge).toEqual({ active: false, userId: null });
  });

  it("reports forge hosting when the world is on The Forge", async () => {
    const mock = new MockFoundry({
      worldInfo: { forge: { active: true, userId: "forge-user-1" } },
    });
    const transport = new MockTransport(mock);
    const out = await runGetWorldInfo(transport);
    const info = out.ok ? (out.data as any) : null;
    expect(info.forge).toEqual({ active: true, userId: "forge-user-1" });
  });
});

describe("create_embedded pipeline", () => {
  it("rolls back the created embedded docs when parent read-back fails", async () => {
    const { mock, transport } = setup();
    await seedScene(mock);
    transport.failFindAtCall = 1; // createEmbedded's only find is the read-back
    const out = await runCreateEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", name: "Goblin" }],
    });
    expectErr(out, "READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // The created token was removed by the rollback.
    const scene = mock.documents("Scene")[0] as { tokens: unknown[] };
    expect(scene.tokens.length).toBe(0);
  });

  it("does not verify/roll back for an embedded type with no known field mapping", async () => {
    const { mock, transport } = setup();
    await seed(mock, {
      action: "create",
      documentType: "Playlist",
      data: { _id: "pl1", name: "Tunes" },
      keepId: true,
    });
    // Corrupt the read-back so a *mapped* type would false-fail; an unmapped
    // embeddedName (PlaylistSound -> no entry) must skip verification instead.
    transport.corruptFindAtCall = 1;
    const out = await runCreateEmbedded(transport, {
      parentType: "Playlist",
      parentId: "pl1",
      embeddedName: "PlaylistSound",
      data: [{ _id: "ps1", name: "Theme" }],
    });
    expect(out.ok).toBe(true);
    expect(out.steps).not.toContain("rollback");
  });
});

describe("update_embedded pipeline", () => {
  it("updates an embedded doc and verifies via the parent read-back", async () => {
    const { mock, transport } = setup();
    await seedSceneWithToken(mock);
    const out = await runUpdateEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", x: 250 }],
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["pre-read", "dry-run", "write", "read-back"]);
    const scene = mock.documents("Scene")[0] as { tokens: Array<{ x: number }> };
    expect(scene.tokens[0]!.x).toBe(250);
  });

  it("drops unsafe dot-path keys from each embedded diff before the runtime", async () => {
    const { mock, transport } = setup();
    await seedSceneWithToken(mock);
    const out = await runUpdateEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", x: 250, "__proto__.polluted": "x" }],
    });
    expect(out.ok).toBe(true);
    const scene = mock.documents("Scene")[0] as { tokens: Array<{ x: number }> };
    expect(scene.tokens[0]!.x).toBe(250); // safe key applied
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // unsafe key never sent
  });

  it("rejects an entry with no safe fields beyond _id instead of silently no-op succeeding", async () => {
    // Regression test: an entry stripped down to just {_id} is found by that
    // same _id on read-back, so isSubset(actual, {_id}) trivially passes --
    // reporting success while nothing was actually changed. Must fail loudly.
    const { mock, transport } = setup();
    await seedSceneWithToken(mock);
    const out = await runUpdateEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", "__proto__.polluted": "x" }],
    });
    expectErr(out, "VALIDATION");
    const scene = mock.documents("Scene")[0] as { tokens: Array<{ x: number }> };
    expect(scene.tokens[0]!.x).toBe(0); // untouched
  });

  it("restores the prior embedded state when parent read-back fails", async () => {
    const { mock, transport } = setup();
    await seedSceneWithToken(mock);
    transport.failFindAtCall = 2; // 1 = pre-read (must succeed), 2 = read-back (fails)
    const out = await runUpdateEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", x: 999 }],
    });
    expectErr(out, "READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // Rollback restored the token's pre-update x (0), not the failed 999.
    const scene = mock.documents("Scene")[0] as { tokens: Array<{ x: number }> };
    expect(scene.tokens[0]!.x).toBe(0);
  });

  it("rolls back when the read-back parent doesn't reflect the change", async () => {
    const { mock, transport } = setup();
    await seedSceneWithToken(mock);
    transport.corruptFindAtCall = 2; // read-back succeeds but lacks the updated token
    const out = await runUpdateEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", x: 999 }],
    });
    expectErr(out, "READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    const scene = mock.documents("Scene")[0] as { tokens: Array<{ x: number }> };
    expect(scene.tokens[0]!.x).toBe(0);
  });

  it("does not verify/roll back for an embedded type with no known field mapping", async () => {
    const { mock, transport } = setup();
    await seed(mock, {
      action: "create",
      documentType: "Playlist",
      data: { _id: "pl1", name: "Tunes" },
      keepId: true,
    });
    await seed(mock, {
      action: "createEmbedded",
      parentType: "Playlist",
      parentId: "pl1",
      embeddedName: "PlaylistSound",
      data: [{ _id: "ps1", name: "Theme", volume: 0.5 }],
    });
    transport.corruptFindAtCall = 2; // strip the read-back (find #1 is the pre-read)
    const out = await runUpdateEmbedded(transport, {
      parentType: "Playlist",
      parentId: "pl1",
      embeddedName: "PlaylistSound",
      data: [{ _id: "ps1", volume: 1 }],
    });
    expect(out.ok).toBe(true);
    expect(out.steps).not.toContain("rollback");
  });
});

describe("delete_embedded pipeline", () => {
  it("deletes embedded docs as a terminal write (no read-back)", async () => {
    const { mock, transport } = setup();
    await seedSceneWithToken(mock);
    const out = await runDeleteEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      ids: ["t1"],
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write"]);
    const scene = mock.documents("Scene")[0] as { tokens: unknown[] };
    expect(scene.tokens.length).toBe(0);
  });
});

describe("quest pipeline", () => {
  it("create_quest succeeds even when the write echo omits the requested fields", async () => {
    const { transport } = setup();
    // Simulate the module normalizing/dropping fields in its echo; a content
    // verify (which we removed) would false-fail here. Success proves it's gone.
    transport.corruptQuestWrite = true;
    const out = await runCreateQuest(transport, {
      data: { name: "Find the Amulet", status: "Available" },
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write"]);
  });

  it("update_quest succeeds even when the write echo omits the requested fields", async () => {
    const { transport } = setup();
    const created = await runCreateQuest(transport, { data: { name: "Q" } });
    const id = created.ok ? (created.data as { _id: string })._id : "missing";
    transport.corruptQuestWrite = true;
    const out = await runUpdateQuest(transport, { id, data: { status: "Active" } });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write"]);
  });
});

describe("upload_asset", () => {
  it("uploads through dry-run then write and returns the path", async () => {
    const { mock, transport } = setup();
    const out = await runUploadAsset(transport, {
      source: "data",
      target: "worlds/cos/scenes",
      filename: "tavern.webp",
      contentBase64: "AAAA",
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write"]);
    expect(out.ok && (out.data as any).path).toBe("worlds/cos/scenes/tavern.webp");
    expect(mock.filePicker.uploads.length).toBe(1);
  });
});

describe("browse_assets", () => {
  it("returns empty listing for unknown path", async () => {
    const { transport } = setup();
    const out = await runBrowseAssets(transport, { source: "data", target: "worlds/none" });
    if (!out.ok) throw new Error(`browse failed: ${out.error.message}`);
    expect(out.data).toMatchObject({ dirs: [], files: [], target: "worlds/none" });
  });

  it("lists files after upload", async () => {
    const { transport } = setup();
    const up = await runUploadAsset(transport, {
      source: "data",
      target: "worlds/strahd/scenes",
      filename: "village.webp",
      contentBase64: btoa("fake"),
    });
    if (!up.ok) throw new Error("upload failed");
    const out = await runBrowseAssets(transport, { source: "data", target: "worlds/strahd/scenes" });
    if (!out.ok) throw new Error(`browse failed: ${out.error.message}`);
    const data = out.data as { files: string[]; dirs: string[]; target: string };
    expect(data.files).toContain("worlds/strahd/scenes/village.webp");
  });

  it("filters by extension", async () => {
    const { transport } = setup();
    await runUploadAsset(transport, {
      source: "data", target: "worlds/strahd/maps",
      filename: "map.png", contentBase64: btoa("png"),
    });
    await runUploadAsset(transport, {
      source: "data", target: "worlds/strahd/maps",
      filename: "notes.pdf", contentBase64: btoa("pdf"),
    });
    const out = await runBrowseAssets(transport, {
      source: "data", target: "worlds/strahd/maps", extensions: [".png"],
    });
    if (!out.ok) throw new Error(`browse failed: ${out.error.message}`);
    const data = out.data as { files: string[] };
    expect(data.files.some((f) => f.endsWith(".png"))).toBe(true);
    expect(data.files.some((f) => f.endsWith(".pdf"))).toBe(false);
  });

  it("lists subdirectories as dirs", async () => {
    const { transport } = setup();
    // Upload a file one level deeper than the browse target.
    const up = await runUploadAsset(transport, {
      source: "data",
      target: "worlds/strahd/regions/barovia",
      filename: "map.webp",
      contentBase64: btoa("deep"),
    });
    if (!up.ok) throw new Error("upload failed");
    const out = await runBrowseAssets(transport, { source: "data", target: "worlds/strahd/regions" });
    if (!out.ok) throw new Error(`browse failed: ${out.error.message}`);
    const data = out.data as { dirs: string[]; files: string[] };
    expect(data.dirs).toContain("worlds/strahd/regions/barovia");
    expect(data.files).toEqual([]); // the file is in a subdir, not a direct child
  });
});

describe("batch_upload_assets", () => {
  it("uploads multiple files and returns paths", async () => {
    const { transport } = setup();
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
    expect(data[0]!.path).toBe("worlds/strahd/scenes/barovia.webp");
    expect(data[1]!.path).toBe("worlds/strahd/scenes/castle.webp");
  });

  it("skips already-existing files when skipExisting=true", async () => {
    const { transport } = setup();
    const first = await runBatchUploadAssets(transport, {
      source: "data",
      target: "worlds/strahd/tokens",
      files: [{ filename: "strahd.webp", contentBase64: btoa("token") }],
    });
    if (!first.ok) throw new Error(`first upload failed: ${first.error.message}`);
    const existingPath = (first.data as Array<{ path: string }>)[0]!.path;
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
    const skipped = data.find((f) => f.filename === "strahd.webp");
    expect(skipped?.skipped).toBe(true);
    // The skipped entry reports the asset's actual existing path, not a guess.
    expect(skipped?.path).toBe(existingPath);
    expect(data.find((f) => f.filename === "ireena.webp")?.skipped).toBeFalsy();
  });

  // skipExisting owns the dedup contract: with it on, a filename repeated within
  // one batch is uploaded once and the later copy is skipped.
  it("skips in-batch duplicate filenames when skipExisting=true", async () => {
    const { transport } = setup();
    const out = await runBatchUploadAssets(transport, {
      source: "data",
      target: "worlds/strahd/maps",
      files: [
        { filename: "dup.webp", contentBase64: btoa("a") },
        { filename: "dup.webp", contentBase64: btoa("b") },
      ],
      skipExisting: true,
    });
    if (!out.ok) throw new Error(`batch upload failed: ${out.error.message}`);
    const data = out.data as Array<{ filename: string; skipped?: boolean }>;
    expect(data[0]!.skipped).toBeFalsy();
    expect(data[1]!.skipped).toBe(true);
  });

  // With skipExisting off the caller asked to upload everything as given —
  // duplicates are NOT silently dropped.
  it("uploads in-batch duplicate filenames when skipExisting is off", async () => {
    const { transport } = setup();
    const out = await runBatchUploadAssets(transport, {
      source: "data",
      target: "worlds/strahd/maps",
      files: [
        { filename: "dup.webp", contentBase64: btoa("a") },
        { filename: "dup.webp", contentBase64: btoa("b") },
      ],
    });
    if (!out.ok) throw new Error(`batch upload failed: ${out.error.message}`);
    const data = out.data as Array<{ filename: string; skipped?: boolean }>;
    expect(data[0]!.skipped).toBeFalsy();
    expect(data[1]!.skipped).toBeFalsy();
  });
});

describe("duplicate_document pipeline", () => {
  const seedGoblin = (mock: MockFoundry) =>
    seed(mock, {
      action: "create",
      documentType: "Actor",
      data: { _id: "g1", name: "Goblin", system: { hp: { value: 7 } } },
      keepId: true,
    });

  it("clones a document with overrides, leaving the original intact", async () => {
    const { mock, transport } = setup();
    await seedGoblin(mock);
    const out = await runDuplicateDocument(transport, {
      documentType: "Actor",
      id: "g1",
      overrides: { name: "Goblin Boss" },
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write", "read-back"]);
    const actors = mock.documents("Actor") as Array<{ name: string; system: { hp: { value: number } } }>;
    expect(actors.length).toBe(2);
    const names = actors.map((a) => a.name).sort();
    expect(names).toEqual(["Goblin", "Goblin Boss"]);
    // The copy inherited the source's nested data.
    const copy = actors.find((a) => a.name === "Goblin Boss")!;
    expect(copy.system.hp.value).toBe(7);
  });

  it("returns NOT_FOUND when the source does not exist", async () => {
    const { transport } = setup();
    const out = await runDuplicateDocument(transport, { documentType: "Actor", id: "ghost" });
    expectErr(out, "NOT_FOUND");
  });

  it("rolls back the copy when read-back does not match the overrides", async () => {
    const { mock, transport } = setup();
    await seedGoblin(mock);
    transport.corruptReadBack = true;
    const out = await runDuplicateDocument(transport, {
      documentType: "Actor",
      id: "g1",
      overrides: { name: "Goblin Boss" },
    });
    expectErr(out, "READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // Only the original survives; the rolled-back copy is gone.
    expect(mock.documents("Actor").length).toBe(1);
  });

  it("rejects overrides with no safe fields instead of silently cloning as-is", async () => {
    // Regression test: overrides is optional (undefined = clone as-is is fine),
    // but if the caller explicitly supplied overrides and every key was
    // stripped as unsafe, silently falling back to a plain clone would drop
    // the caller's actual intent with no error.
    const { mock, transport } = setup();
    await seedGoblin(mock);
    const out = await runDuplicateDocument(transport, {
      documentType: "Actor",
      id: "g1",
      overrides: { "__proto__.polluted": "x" },
    });
    expectErr(out, "VALIDATION");
    // No clone was created -- rejected before the pipeline ever ran.
    expect(mock.documents("Actor").length).toBe(1);
  });

  it("rejects a literal empty overrides object the same way", async () => {
    // A caller-supplied {} (not something filterUnsafePaths stripped down to
    // empty) must be rejected identically -- isEmptyDiff doesn't care why the
    // object is empty, and both are equally "supplied but nothing to apply".
    const { mock, transport } = setup();
    await seedGoblin(mock);
    const out = await runDuplicateDocument(transport, { documentType: "Actor", id: "g1", overrides: {} });
    expectErr(out, "VALIDATION");
    expect(mock.documents("Actor").length).toBe(1);
  });
});

describe("search_compendium / import_from_compendium pipeline", () => {
  const GRAVEMIRE_UUID = "Compendium.dnd5e.actors24.gravemire-stalker";

  it("finds a fixture by name and document type", async () => {
    const { transport } = setup();
    const out = await runSearchCompendium(transport, { documentType: "Actor", nameQuery: "Gravemire" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const results = out.data as Array<{ uuid: string; pack: string; name: string; type: string }>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      uuid: GRAVEMIRE_UUID,
      pack: "dnd5e.actors24",
      name: "Gravemire Stalker",
      // The result's `type` is the fixture's real game-system subtype, not the
      // top-level DocumentType ("Actor") — guards against the two being conflated.
      type: "npc",
    });
  });

  it("excludes matches of the wrong document type", async () => {
    const { transport } = setup();
    const out = await runSearchCompendium(transport, { documentType: "Item", nameQuery: "Gravemire" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data).toEqual([]);
  });

  it("excludes matches outside the requested pack scope", async () => {
    const { transport } = setup();
    const out = await runSearchCompendium(transport, {
      documentType: "Actor",
      nameQuery: "Gravemire",
      packScope: "pf2e",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data).toEqual([]);
  });

  it("imports a compendium fixture into the world with a fresh id", async () => {
    const { mock, transport } = setup();
    const out = await runImportFromCompendium(transport, {
      documentType: "Actor",
      uuid: GRAVEMIRE_UUID,
      fields: ["_id", "name", "type"],
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write", "read-back"]);
    if (!out.ok) return;
    const imported = out.data as { _id: string; name: string; type: string };
    expect(imported.name).toBe("Gravemire Stalker");
    expect(imported.type).toBe("npc");
    expect(imported._id).not.toBe("gravemire-stalker");
    expect(mock.documents("Actor").some((a) => (a as { _id: string })._id === imported._id)).toBe(true);
  });

  it("applies a patch and verifies it survives read-back", async () => {
    const { transport } = setup();
    const out = await runImportFromCompendium(transport, {
      documentType: "Actor",
      uuid: GRAVEMIRE_UUID,
      patch: { name: "Patched Stalker" },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.data as { name: string }).name).toBe("Patched Stalker");
  });

  it("applies a dot-notation patch without a false READBACK_MISMATCH", async () => {
    // Regression test: the read-back check must expand a dot-notation patch
    // before comparing against the (nested) read-back document, or every
    // multi-segment patch key spuriously fails and the import gets rolled back.
    const { transport } = setup();
    const out = await runImportFromCompendium(transport, {
      documentType: "Actor",
      uuid: GRAVEMIRE_UUID,
      patch: { "system.attributes.hp.value": 1 },
      fields: ["_id", "system.attributes.hp.value"],
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write", "read-back"]);
    if (!out.ok) return;
    const data = out.data as { system: { attributes: { hp: { value: number } } } };
    expect(data.system.attributes.hp.value).toBe(1);
  });

  it("returns NOT_FOUND for an unknown uuid", async () => {
    const { transport } = setup();
    const out = await runImportFromCompendium(transport, {
      documentType: "Actor",
      uuid: "Compendium.dnd5e.actors24.does-not-exist",
    });
    expectErr(out, "NOT_FOUND");
  });

  it("rejects a patch with no safe fields instead of silently importing as-is", async () => {
    // Regression test: patch is optional (undefined = clone as-is is fine),
    // but if the caller explicitly supplied a patch and every key was
    // stripped as unsafe, silently falling back to a plain import would drop
    // the caller's actual intent with no error.
    const { mock, transport } = setup();
    const out = await runImportFromCompendium(transport, {
      documentType: "Actor",
      uuid: GRAVEMIRE_UUID,
      patch: { "__proto__.polluted": "x" },
    });
    expectErr(out, "VALIDATION");
    // No import happened -- rejected before the pipeline ever ran.
    expect(mock.documents("Actor").length).toBe(0);
  });

  it("rejects a literal empty patch object the same way", async () => {
    // A caller-supplied {} (not something filterUnsafePaths stripped down to
    // empty) must be rejected identically -- isEmptyDiff doesn't care why the
    // object is empty, and both are equally "supplied but nothing to apply".
    const { mock, transport } = setup();
    const out = await runImportFromCompendium(transport, { documentType: "Actor", uuid: GRAVEMIRE_UUID, patch: {} });
    expectErr(out, "VALIDATION");
    expect(mock.documents("Actor").length).toBe(0);
  });

  it("does not leak embedded-item mutations back into the compendium fixture", async () => {
    const { mock, transport } = setup();
    const first = await runImportFromCompendium(transport, { documentType: "Actor", uuid: GRAVEMIRE_UUID });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = (first.data as { _id: string })._id;

    const embed = await runCreateEmbedded(transport, {
      parentType: "Actor",
      parentId: firstId,
      embeddedName: "Item",
      data: [{ name: "Phantom Item", type: "weapon" }],
    });
    expect(embed.ok).toBe(true);

    // A second, independent import from the same fixture must be unaffected
    // by the first import's later mutation.
    const second = await runImportFromCompendium(transport, { documentType: "Actor", uuid: GRAVEMIRE_UUID });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondId = (second.data as { _id: string })._id;
    const secondDoc = mock.documents("Actor").find((a) => (a as { _id: string })._id === secondId) as {
      items?: unknown[];
    };
    expect(secondDoc.items).toHaveLength(5);
  });
});

describe("quest hierarchies and rewards", () => {
  it("creates a sub-quest with parentId reference", async () => {
    const { mock, transport } = setup();
    // Create parent quest
    const parentOut = await runCreateQuest(transport, {
      data: { name: "Main Quest", status: "active" },
    });
    expect(parentOut.ok).toBe(true);
    if (!parentOut.ok) throw new Error("parent quest creation failed");
    const parentId = (parentOut.data as { _id: string })._id;

    // Create sub-quest
    const subOut = await runCreateQuest(transport, {
      data: { name: "Side Objective", status: "active" },
      parentId,
    });
    expect(subOut.ok).toBe(true);
    expect(subOut.steps).toContain("write");

    const quests = Array.from(mock.quests.values());
    expect(quests.length).toBe(2);
    const subQuest = quests.find((q: any) => q._id !== parentId) as any;
    expect(subQuest.parent).toBe(parentId);
  });

  it("creates a quest with rewards (items, gold, xp)", async () => {
    const { transport } = setup();
    const out = await runCreateQuest(transport, {
      data: {
        name: "Rescue the Princess",
        status: "active",
        rewards: {
          items: [
            { name: "Crown of Wisdom", type: "loot", value: 500 },
            { name: "Ring of Protection", type: "wondrous", bonus: 1 },
          ],
          gold: 1000,
          xp: 5000,
        },
      },
    });
    expect(out.ok).toBe(true);
    const quest = out.ok ? (out.data as any) : null;
    expect(quest?.rewards?.items?.length).toBe(2);
    expect(quest?.rewards?.items?.[0]?.name).toBe("Crown of Wisdom");
    expect(quest?.rewards?.gold).toBe(1000);
    expect(quest?.rewards?.xp).toBe(5000);
  });

  it("creates a hierarchical quest structure with sub-quests and rewards", async () => {
    const { mock, transport } = setup();

    // Create main quest with rewards
    const mainOut = await runCreateQuest(transport, {
      data: {
        name: "Complete the Dungeon",
        status: "active",
        rewards: { xp: 10000, gold: 2000 },
      },
    });
    expect(mainOut.ok).toBe(true);
    if (!mainOut.ok) throw new Error("main quest creation failed");
    const mainId = (mainOut.data as { _id: string })._id;

    // Create first sub-quest
    const sub1Out = await runCreateQuest(transport, {
      data: {
        name: "Defeat the Minions",
        status: "active",
        rewards: { xp: 3000, gold: 500 },
      },
      parentId: mainId,
    });
    expect(sub1Out.ok).toBe(true);
    if (!sub1Out.ok) throw new Error("sub1 quest creation failed");
    const sub1Id = (sub1Out.data as { _id: string })._id;

    // Create second sub-quest with item rewards
    const sub2Out = await runCreateQuest(transport, {
      data: {
        name: "Retrieve the Artifact",
        status: "active",
        rewards: {
          items: [{ name: "Ancient Artifact", type: "relic", rarity: "legendary" }],
          xp: 4000,
          gold: 1000,
        },
      },
      parentId: mainId,
    });
    expect(sub2Out.ok).toBe(true);
    if (!sub2Out.ok) throw new Error("sub2 quest creation failed");

    // Verify structure
    const quests = Array.from(mock.quests.values());
    expect(quests.length).toBe(3);

    const main = quests.find((q: any) => q._id === mainId) as any;
    expect(main.name).toBe("Complete the Dungeon");
    expect(main.rewards.xp).toBe(10000);
    expect(main.rewards.gold).toBe(2000);

    const sub1 = quests.find((q: any) => q._id === sub1Id) as any;
    expect(sub1.parent).toBe(mainId);
    expect(sub1.rewards.gold).toBe(500);

    const sub2 = quests.find((q: any) => q._id !== sub1Id && q.parent === mainId) as any;
    expect(sub2.name).toBe("Retrieve the Artifact");
    expect(sub2.rewards.items?.[0]?.name).toBe("Ancient Artifact");
  });

  it("update_quest changes rewards and status", async () => {
    const { mock, transport } = setup();
    const created = await runCreateQuest(transport, {
      data: { name: "Fetch Quest", status: "inactive", rewards: { xp: 100 } },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("quest creation failed");
    const questId = (created.data as { _id: string })._id;

    const updated = await runUpdateQuest(transport, {
      id: questId,
      data: { status: "completed", rewards: { xp: 500, gold: 250 } },
    });
    expect(updated.ok).toBe(true);

    const quest = mock.quests.get(questId) as any;
    expect(quest.status).toBe("completed");
    expect(quest.rewards.xp).toBe(500);
    expect(quest.rewards.gold).toBe(250);
  });
});
