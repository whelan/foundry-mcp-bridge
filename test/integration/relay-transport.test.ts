import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "@foundry-mcp-bridge/shared";
import {
  WebSocketRelayTransport,
  type WsLike,
} from "../../packages/mcp-server/src/relay-transport.js";

/** Fake WebSocket that lets a test drive open/message/close/error events. */
class FakeWs implements WsLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, l: (ev: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(l);
  }
  removeEventListener(type: string, l: (ev: { data?: unknown }) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== l);
  }
  fire(type: string, ev: { data?: unknown } = {}): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
  listenerCount(type: string): number {
    return (this.listeners[type] ?? []).length;
  }
}

const findEnvelope = (id: string) => ({
  id,
  protocolVersion: PROTOCOL_VERSION,
  dryRun: false,
  command: { action: "find" as const, documentType: "Actor" as const },
});

/** Let request() get past `await this.ready` and register its pending entry. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("WebSocketRelayTransport", () => {
  it("fails in-flight requests fast when the socket drops (no timeout wait)", async () => {
    const ws = new FakeWs();
    // High timeout: the test only passes if the drop drains pending immediately.
    const t = new WebSocketRelayTransport({
      url: "ws://x",
      defaultTimeoutMs: 60_000,
      createSocket: () => ws,
    });
    ws.fire("open");
    const pending = t.request(findEnvelope("r1"));
    await flush();
    ws.fire("close");
    const res = await pending;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INTERNAL");
  });

  it("drains pending and removes listeners on close()", async () => {
    const ws = new FakeWs();
    const t = new WebSocketRelayTransport({
      url: "ws://x",
      defaultTimeoutMs: 60_000,
      createSocket: () => ws,
    });
    ws.fire("open");
    const pending = t.request(findEnvelope("r2"));
    await flush();
    t.close();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(ws.closed).toBe(true);
    expect(ws.listenerCount("message")).toBe(0);
    expect(ws.listenerCount("close")).toBe(0);
  });
});
