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
} from "../../packages/mcp-server/src/tools.js";

/** Transport that drives the mock-foundry, with hooks to exercise the pipeline. */
class MockTransport implements RelayTransport {
  corruptReadBack = false;
  constructor(private readonly mock: MockFoundry) {}

  async request(envelope: CommandEnvelope, opts?: RequestOptions) {
    const exec = (async () => {
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
