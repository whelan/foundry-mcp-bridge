import { describe, it, expect } from "vitest";
import type { Command, CommandEnvelope, CommandError } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import {
  type RelayTransport,
  type RequestOptions,
  withTimeout,
} from "../../packages/mcp-server/src/relay-transport.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";
import {
  runCreateDocument,
  runCreateScene,
  runUpdateDocument,
  runDuplicateDocument,
  runGetWorldInfo,
  runUploadAsset,
  runCreateEmbedded,
  runUpdateEmbedded,
  runDeleteEmbedded,
  runCreateQuest,
  runUpdateQuest,
} from "../../packages/mcp-server/src/tools.js";

/** Transport that drives the mock-foundry, with hooks to exercise the pipeline. */
class MockTransport implements RelayTransport {
  corruptReadBack = false;
  /** Fail the Nth `find` (1-indexed) with NOT_FOUND; null disables. Lets tests
   *  target the read-back find specifically (e.g. after an update's pre-read). */
  failFindAtCall: number | null = null;
  /** Strip the Nth `find` result to just `{_id}`, so read-back verification fails
   *  even though the find succeeded (e.g. an embedded change that didn't land). */
  corruptFindAtCall: number | null = null;
  private findCalls = 0;
  constructor(private readonly mock: MockFoundry) {}

  async request(envelope: CommandEnvelope, opts?: RequestOptions) {
    const exec = (async () => {
      const isFind = envelope.command.action === "find";
      if (isFind) {
        this.findCalls += 1;
        if (this.findCalls === this.failFindAtCall) {
          return {
            id: envelope.id,
            ok: false as const,
            error: { code: "NOT_FOUND" as const, message: "read-back failed" },
          };
        }
      }
      // Clone like the real WebSocket transport serializes results, so callers
      // never alias the mock's live store (e.g. an update's pre-read snapshot).
      const res = structuredClone(await this.mock.execute(envelope));
      const corrupt =
        res.ok && isFind && (this.corruptReadBack || this.findCalls === this.corruptFindAtCall);
      if (corrupt) {
        this.corruptReadBack = false;
        // Strip everything but the id so read-back verification fails.
        return { id: res.id, ok: true as const, data: { _id: (res.data as { _id: string })._id } };
      }
      return res;
    })();
    return opts?.timeoutMs ? withTimeout(exec, opts.timeoutMs) : exec;
  }

  close(): void {}
}

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
  return mock.execute({ id: "seed", protocolVersion: "1", dryRun: false, command });
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
  it("create_quest confirms via write + _id without a content read-back", async () => {
    const { transport } = setup();
    // status casing differs from what a module would store; must NOT false-fail.
    const out = await runCreateQuest(transport, { data: { name: "Find the Amulet", status: "Available" } });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write"]);
  });

  it("update_quest confirms the write without re-verifying normalized content", async () => {
    const { transport } = setup();
    const created = await runCreateQuest(transport, { data: { name: "Q" } });
    const id = created.ok ? (created.data as { _id: string })._id : "missing";
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
});
