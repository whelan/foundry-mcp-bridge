import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { CommandEnvelope, PROTOCOL_VERSION } from "@foundry-mcp-bridge/shared";
import { RelayServer } from "../../packages/mcp-server/src/relay-server.js";
import {
  AutoRelayTransport,
  PeerRelayTransport,
} from "../../packages/mcp-server/src/relay-peer.js";

const TOKEN = "secret";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function envelope(name: string): CommandEnvelope {
  return CommandEnvelope.parse({
    id: randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    token: TOKEN,
    dryRun: false,
    command: { action: "find", documentType: "Actor", query: { name } },
  });
}

/** Fake module: echoes each envelope's id back with its query name. */
async function connectModule(port: number, opts: { silent?: boolean } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}?token=${TOKEN}`);
  cleanups.push(() => ws.close());
  ws.on("message", (data) => {
    if (opts.silent) return;
    const env = JSON.parse(data.toString()) as { id: string; command: { query: { name: string } } };
    ws.send(JSON.stringify({ id: env.id, ok: true, data: { echo: env.command.query.name } }));
  });
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  await tick();
  return ws;
}

async function relay(defaultTimeoutMs = 1000) {
  const server = new RelayServer({ url: "ws://localhost:0", token: TOKEN, defaultTimeoutMs });
  cleanups.push(() => server.close());
  return { server, port: await server.listening() };
}

function peer(port: number, defaultTimeoutMs = 1000) {
  const p = new PeerRelayTransport({ url: `ws://localhost:${port}`, token: TOKEN, defaultTimeoutMs, reconnectDelayMs: 50 });
  cleanups.push(() => p.close());
  return p;
}

async function freePort(): Promise<number> {
  const { server, port } = await relay();
  server.close();
  await tick(50);
  return port;
}

describe("RelayServer peer mode", () => {
  it("routes each peer's results back to that peer (and the owner's own)", async () => {
    const { server, port } = await relay();
    await connectModule(port);
    const a = peer(port);
    const b = peer(port);
    await Promise.all([a.connected(), b.connected()]);
    const [ra, rb, rs] = await Promise.all([
      a.request(envelope("alpha")),
      b.request(envelope("beta")),
      server.request(envelope("self")),
    ]);
    expect(ra).toMatchObject({ ok: true, data: { echo: "alpha" } });
    expect(rb).toMatchObject({ ok: true, data: { echo: "beta" } });
    expect(rs).toMatchObject({ ok: true, data: { echo: "self" } });
  });

  it("rejects a peer with a bad token", async () => {
    const { port } = await relay();
    const p = new PeerRelayTransport({ url: `ws://localhost:${port}`, token: "wrong", defaultTimeoutMs: 100, reconnectDelayMs: 1000 });
    cleanups.push(() => p.close());
    await tick(50); // the relay accepts then closes with 1008
    const r = await p.request(envelope("nope"), { timeoutMs: 100 }).catch((e: Error) => e);
    expect(r instanceof Error || (r as { ok: boolean }).ok === false).toBe(true);
  });

  it("replies TIMEOUT to a peer when no module connects", async () => {
    const { port } = await relay(80);
    const p = peer(port);
    await p.connected();
    const env = envelope("lonely");
    const r = await p.request(env, { timeoutMs: 1000 });
    expect(r).toMatchObject({ id: env.id, ok: false, error: { code: "TIMEOUT" } });
  });

  it("fails a peer's in-flight request when the module disconnects", async () => {
    const { port } = await relay(5000);
    const mod = await connectModule(port, { silent: true });
    const p = peer(port);
    await p.connected();
    const pending = p.request(envelope("x"), { timeoutMs: 5000 });
    await tick();
    mod.close();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(r)).toMatch(/disconnected/);
  });
});

describe("AutoRelayTransport", () => {
  it("falls back to peer mode on EADDRINUSE and shares the module", async () => {
    const port = await freePort();
    const url = `ws://localhost:${port}`;
    const owner = new AutoRelayTransport({ url, token: TOKEN, defaultTimeoutMs: 1000 });
    cleanups.push(() => owner.close());
    expect(await owner.start()).toBe("owner");
    const second = new AutoRelayTransport({ url, token: TOKEN, defaultTimeoutMs: 1000 });
    cleanups.push(() => second.close());
    expect(await second.start()).toBe("peer");
    await connectModule(port);
    expect(await second.request(envelope("via-peer"))).toMatchObject({ ok: true, data: { echo: "via-peer" } });
    expect(await owner.request(envelope("via-owner"))).toMatchObject({ ok: true, data: { echo: "via-owner" } });
  });

  it("promotes a peer to owner after the owner closes", async () => {
    const port = await freePort();
    const url = `ws://localhost:${port}`;
    const owner = new AutoRelayTransport({ url, token: TOKEN, defaultTimeoutMs: 1000 });
    cleanups.push(() => owner.close());
    await owner.start();
    const second = new AutoRelayTransport({ url, token: TOKEN, defaultTimeoutMs: 1000, reconnectDelayMs: 50 });
    cleanups.push(() => second.close());
    expect(await second.start()).toBe("peer");
    owner.close();
    for (let i = 0; i < 50 && second.mode !== "owner"; i++) await tick(20);
    expect(second.mode).toBe("owner");
    await connectModule(port);
    expect(await second.request(envelope("promoted"))).toMatchObject({ ok: true, data: { echo: "promoted" } });
  });
});
