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
});
