import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION, type CommandResult } from "@foundry-mcp-bridge/shared";
import { RelayClient, type WebSocketLike } from "./relay-client.js";
import type { FoundryDocumentApi } from "./protocol-executor.js";

class FakeWebSocket implements WebSocketLike {
  onopen: ((ev: unknown) => unknown) | null = null;
  onclose: ((ev: unknown) => unknown) | null = null;
  onerror: ((ev: unknown) => unknown) | null = null;
  onmessage: ((ev: { data: unknown }) => unknown) | null = null;
  readonly sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Simulate an inbound server message. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  lastResult(): CommandResult {
    return JSON.parse(this.sent[this.sent.length - 1]!) as CommandResult;
  }
}

/** Minimal api that records creates and echoes the data back. */
function stubApi(): FoundryDocumentApi {
  return {
    async create(_type, data) {
      return { ...data, _id: "created" };
    },
    async update(_type, _id, diff) {
      return { ...diff, _id };
    },
    async remove() {},
    async createEmbedded(_p, _id, _name, data) {
      return data;
    },
    async updateEmbedded(_p, _id, _name, data) {
      return data;
    },
    async deleteEmbedded() {},
    async find() {
      return [];
    },
    async createQuest(data) {
      return { ...data, _id: "quest" };
    },
    async updateQuest(id, data) {
      return { ...data, _id: id };
    },
    async deleteQuest() {},
  };
}

function client(socket: FakeWebSocket) {
  const c = new RelayClient({
    url: "ws://test",
    api: stubApi(),
    context: { isGM: true },
    createSocket: () => socket,
  });
  c.connect();
  return c;
}

describe("RelayClient", () => {
  it("executes a valid envelope and sends an ok result", async () => {
    const socket = new FakeWebSocket();
    const c = client(socket);
    const result = await c.handleMessage(
      JSON.stringify({
        id: "x1",
        protocolVersion: PROTOCOL_VERSION,
        command: { action: "create", documentType: "Actor", data: { name: "Bob" } },
      }),
    );
    expect(result.ok).toBe(true);
    expect(socket.lastResult().id).toBe("x1");
  });

  it("returns a VALIDATION error for a malformed envelope", async () => {
    const socket = new FakeWebSocket();
    const c = client(socket);
    const result = await c.handleMessage(JSON.stringify({ id: "x2", command: { action: "nope" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    expect(socket.lastResult().id).toBe("x2");
  });

  it("handles non-JSON input without throwing", async () => {
    const socket = new FakeWebSocket();
    const c = client(socket);
    const result = await c.handleMessage("{not json");
    expect(result.ok).toBe(false);
  });

  it("wires onmessage through to a sent result", async () => {
    const socket = new FakeWebSocket();
    client(socket);
    socket.emit(
      JSON.stringify({
        id: "x3",
        protocolVersion: PROTOCOL_VERSION,
        command: { action: "find", documentType: "Actor" },
      }),
    );
    // allow the async handler to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.sent.length).toBe(1);
    expect(socket.lastResult().id).toBe("x3");
  });

  it("disconnect closes the socket", () => {
    const socket = new FakeWebSocket();
    const c = client(socket);
    c.disconnect();
    expect(socket.closed).toBe(true);
  });
});
