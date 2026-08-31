import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  CommandEnvelope,
} from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import { RelayServer } from "../../packages/mcp-server/src/relay-server.js";
import { runCreateDocument } from "../../packages/mcp-server/src/tools.js";

const TOKEN = "secret";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** Stand up a relay server and a ws "module" that executes against the mock. */
async function harness(token: string | undefined = TOKEN, connectModule = true) {
  const mock = new MockFoundry();
  const server = new RelayServer({
    url: "ws://localhost:0",
    token,
    defaultTimeoutMs: 1000,
  });
  cleanups.push(() => server.close());
  const port = await server.listening();

  if (!connectModule) return { mock, server, port };

  const url = token ? `ws://localhost:${port}?token=${token}` : `ws://localhost:${port}`;
  const module = new WebSocket(url);
  cleanups.push(() => module.close());
  module.on("message", async (data) => {
    const envelope = CommandEnvelope.parse(JSON.parse(data.toString()));
    const result = await mock.execute(envelope);
    module.send(JSON.stringify(result));
  });
  await new Promise<void>((resolve, reject) => {
    module.on("open", () => resolve());
    module.on("error", reject);
  });
  // Give the server a tick to register the connection.
  await new Promise((r) => setTimeout(r, 10));
  return { mock, server, port, module };
}

describe("RelayServer end-to-end (real WebSocket)", () => {
  it("drives the create pipeline through a connected module", async () => {
    const { mock, server } = await harness();
    const out = await runCreateDocument(
      server,
      { documentType: "Actor", data: { name: "Bob" } },
      { token: TOKEN, timeoutMs: 1000 },
    );
    expect(out.ok).toBe(true);
    expect(mock.documents("Actor").length).toBe(1);
  });

  it("times out with TIMEOUT when no module is connected", async () => {
    const { server } = await harness(TOKEN, false);
    const out = await runCreateDocument(
      server,
      { documentType: "Actor", data: { name: "Lonely" } },
      { token: TOKEN, timeoutMs: 50 },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TIMEOUT");
  });

  it("close() fails a waiting request fast instead of hanging until timeout", async () => {
    const server = new RelayServer({ url: "ws://localhost:0", token: TOKEN, defaultTimeoutMs: 60_000 });
    cleanups.push(() => server.close());
    await server.listening();
    // No module connected: the request parks in waitForClient with a long timeout.
    const pending = runCreateDocument(
      server,
      { documentType: "Actor", data: { name: "Pending" } },
      { token: TOKEN, timeoutMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 10)); // let it enter waitForClient
    server.close(); // must wake the waiter; without the fix this hangs ~60s
    const out = await pending;
    expect(out.ok).toBe(false);
  });

  it("rejects a module presenting the wrong token", async () => {
    const { server, port } = await harness(TOKEN, false);
    const bad = new WebSocket(`ws://localhost:${port}?token=wrong`);
    cleanups.push(() => bad.close());
    const closed = await new Promise<boolean>((resolve) => {
      bad.on("close", () => resolve(true));
      bad.on("error", () => resolve(true));
      setTimeout(() => resolve(false), 300);
    });
    expect(closed).toBe(true);
    // With no authenticated client, requests time out. data must be non-empty
    // -- an empty diff is now rejected before any transport contact, which
    // would pass this assertion for the wrong reason without ever exercising
    // the no-authenticated-client timeout path this test is meant to cover.
    const out = await runCreateDocument(
      server,
      { documentType: "Actor", data: { name: "Bob" } },
      { token: TOKEN, timeoutMs: 50 },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TIMEOUT");
  });

  // A Mac sleep/wake cycle (or any transient network blip) delivers a socket
  // "error" — ECONNRESET, EPIPE, ENETDOWN — to the underlying `ws` objects
  // before (or sometimes instead of) a clean "close". `ws` sockets are plain
  // Node EventEmitters: an "error" event with no listener throws synchronously
  // and takes the whole MCP server process down with it, which is why a sleep
  // cycle looked like *both* foundry and forge tools vanishing at once (they
  // share one process). These two tests assert the server survives an errored
  // client socket and an errored listen socket without crashing, and keeps
  // serving new connections afterwards.
  it("survives a connected module's socket erroring, and serves a reconnect", async () => {
    const { server, module } = await harness();
    if (!module) throw new Error("harness() with connectModule=true always returns module");
    const clientSocket = (server as unknown as { client: WebSocket }).client;
    expect(clientSocket).toBeDefined();

    // Simulate the OS-level error a sleep/wake network reset delivers.
    clientSocket.emit("error", new Error("simulated ECONNRESET"));
    module.close();
    await new Promise((r) => setTimeout(r, 20)); // let the close handler drain

    // The process (and this test) is still alive: the reconnect path works.
    const port = server.address();
    const reconnected = new WebSocket(`ws://localhost:${port}?token=${TOKEN}`);
    cleanups.push(() => reconnected.close());
    const mock2 = new MockFoundry();
    reconnected.on("message", async (data) => {
      const envelope = CommandEnvelope.parse(JSON.parse(data.toString()));
      const result = await mock2.execute(envelope);
      reconnected.send(JSON.stringify(result));
    });
    await new Promise<void>((resolve, reject) => {
      reconnected.on("open", () => resolve());
      reconnected.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 10));

    const out = await runCreateDocument(
      server,
      { documentType: "Actor", data: { name: "After Reconnect" } },
      { token: TOKEN, timeoutMs: 1000 },
    );
    expect(out.ok).toBe(true);
  });

  it("survives the listen socket itself erroring", async () => {
    const { server } = await harness(TOKEN, false);
    const wss = (server as unknown as { wss: { emit(event: string, err: Error): void } }).wss;

    // Must not throw / crash the process.
    expect(() => wss.emit("error", new Error("simulated EADDRINUSE"))).not.toThrow();

    // The server is still usable afterwards (times out cleanly, doesn't hang
    // or crash, since no module is connected in this test).
    const out = await runCreateDocument(
      server,
      { documentType: "Actor", data: { name: "Still Alive" } },
      { token: TOKEN, timeoutMs: 50 },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TIMEOUT");
  });
});
