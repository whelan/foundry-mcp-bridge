import { describe, it, expect } from "vitest";
import type { CommandEnvelope } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import {
  type RelayTransport,
  type RequestOptions,
  withTimeout,
} from "../../packages/mcp-server/src/relay-transport.js";
import {
  runCreateDocument,
  runCreateScene,
  runUpdateDocument,
  runDuplicateDocument,
  runGetWorldInfo,
  runUploadAsset,
  runCreateEmbedded,
} from "../../packages/mcp-server/src/tools.js";

/** Transport that drives the mock-foundry, with hooks to exercise the pipeline. */
class MockTransport implements RelayTransport {
  corruptReadBack = false;
  /** One-shot: make the next read-back find return a NOT_FOUND error. */
  failNextFind = false;
  constructor(private readonly mock: MockFoundry) {}

  async request(envelope: CommandEnvelope, opts?: RequestOptions) {
    const exec = (async () => {
      if (this.failNextFind && envelope.command.action === "find") {
        this.failNextFind = false;
        return {
          id: envelope.id,
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "read-back failed" },
        };
      }
      const res = await this.mock.execute(envelope);
      if (
        this.corruptReadBack &&
        envelope.command.action === "find" &&
        res.ok &&
        !envelope.dryRun
      ) {
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
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("READBACK_MISMATCH");
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
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TIMEOUT");
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
    await mock.execute({
      id: "seed",
      protocolVersion: "1",
      dryRun: false,
      command: { action: "create", documentType: "Actor", data: { _id: "a1", name: "Bob", system: { hp: { value: 1 } } } },
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
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("NOT_FOUND");
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
    await mock.execute({
      id: "seed",
      protocolVersion: "1",
      dryRun: false,
      command: { action: "create", documentType: "Scene", data: { _id: "s1", name: "Map" } },
    });
    transport.failNextFind = true;
    const out = await runCreateEmbedded(transport, {
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", name: "Goblin" }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // The created token was removed by the rollback.
    const scene = mock.documents("Scene")[0] as { tokens: unknown[] };
    expect(scene.tokens.length).toBe(0);
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
  async function seedGoblin(mock: MockFoundry) {
    await mock.execute({
      id: "seed",
      protocolVersion: "1",
      dryRun: false,
      command: {
        action: "create",
        documentType: "Actor",
        data: { _id: "g1", name: "Goblin", system: { hp: { value: 7 } } },
      },
    });
  }

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
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("NOT_FOUND");
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
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // Only the original survives; the rolled-back copy is gone.
    expect(mock.documents("Actor").length).toBe(1);
  });
});
