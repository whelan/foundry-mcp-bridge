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
    async duplicate(_type, _id, overrides) {
      return { ...overrides, _id: "duplicated" };
    },
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
    async getWorldInfo() {
      return {
        foundryVersion: "13.0.0",
        system: { id: "dnd5e", version: "3.0.0" },
        world: { id: "w", title: "World" },
        folders: [],
        forge: { active: false, userId: null },
      };
    },
    async uploadAsset(params) {
      return { path: `${params.target}/${params.filename}` };
    },
    async browseAssets(_params) {
      return { dirs: [], files: [], target: "/" };
    },
    async batchUploadAssets(params) {
      return params.files.map((f) => ({ filename: f.filename, path: `${params.target}/${f.filename}` }));
    },
    async createQuest(data) {
      return { ...data, _id: "quest" };
    },
    async updateQuest(id, data) {
      return { ...data, _id: id };
    },
    async deleteQuest() {},
    async searchCompendium() {
      return [];
    },
    async importFromCompendium(_documentType, _uuid, patch, _folderId, _opts) {
      return { ...patch, _id: "imported" };
    },
    async importEmbeddedFromCompendium(_p, _id, _name, uuids) {
      return uuids.map((u) => ({ ...u.patch, _id: "imported-embedded" }));
    },
    async getCompendiumDocument(_uuid) {
      return { name: "", type: "", img: undefined, system: {}, items: [] };
    },
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

  it("reconnects with exponential backoff after an unexpected close", () => {
    const sockets = [new FakeWebSocket(), new FakeWebSocket(), new FakeWebSocket()];
    let made = 0;
    const timers: { fn: () => void; ms: number }[] = [];
    const c = new RelayClient({
      url: "ws://test",
      api: stubApi(),
      context: { isGM: true },
      createSocket: () => sockets[made++]!,
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 30000,
      setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimer: () => {},
    });
    c.connect();
    expect(made).toBe(1);

    // First drop → reconnect scheduled at the base delay.
    sockets[0]!.onclose?.({});
    expect(timers[0]!.ms).toBe(1000);
    timers[0]!.fn();
    expect(made).toBe(2);

    // Still failing → delay doubles.
    sockets[1]!.onclose?.({});
    expect(timers[1]!.ms).toBe(2000);
    timers[1]!.fn();
    expect(made).toBe(3);

    // A clean open resets the backoff to the base delay.
    sockets[2]!.onopen?.({});
    sockets[2]!.onclose?.({});
    expect(timers[2]!.ms).toBe(1000);
  });

  it("does not reconnect after an intentional disconnect", () => {
    const socket = new FakeWebSocket();
    const timers: { fn: () => void; ms: number }[] = [];
    const c = new RelayClient({
      url: "ws://test",
      api: stubApi(),
      context: { isGM: true },
      createSocket: () => socket,
      setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimer: () => {},
    });
    c.connect();
    c.disconnect();
    socket.onclose?.({}); // the close event still fires
    expect(timers.length).toBe(0);
  });

  it("does not stack reconnect timers when close fires repeatedly", () => {
    const socket = new FakeWebSocket();
    const timers: { fn: () => void; ms: number }[] = [];
    const c = new RelayClient({
      url: "ws://test",
      api: stubApi(),
      context: { isGM: true },
      createSocket: () => socket,
      setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimer: () => {},
    });
    c.connect();
    // Several close/error events before the scheduled reconnect fires.
    socket.onclose?.({});
    socket.onclose?.({});
    socket.onclose?.({});
    expect(timers.length).toBe(1); // only one timer scheduled, not three
  });

  it("honors reconnect: false", () => {
    const socket = new FakeWebSocket();
    const timers: { fn: () => void; ms: number }[] = [];
    const c = new RelayClient({
      url: "ws://test",
      api: stubApi(),
      context: { isGM: true },
      createSocket: () => socket,
      reconnect: false,
      setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimer: () => {},
    });
    c.connect();
    socket.onclose?.({});
    expect(timers.length).toBe(0);
  });
});
