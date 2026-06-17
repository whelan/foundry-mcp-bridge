import { describe, it, expect } from "vitest";
import { type CommandEnvelope, PROTOCOL_VERSION } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import { mockFoundryApi } from "./mock-foundry-api.js";
import {
  executeCommand,
  type ExecutorContext,
} from "../../packages/foundry-module/src/protocol-executor.js";

function env(env: Partial<CommandEnvelope> & Pick<CommandEnvelope, "command">): CommandEnvelope {
  return {
    id: "e1",
    protocolVersion: PROTOCOL_VERSION,
    dryRun: false,
    ...env,
  };
}

function setup(ctx: Partial<ExecutorContext> = {}) {
  const mock = new MockFoundry();
  const api = mockFoundryApi(mock);
  const context: ExecutorContext = { isGM: true, ...ctx };
  return { mock, api, context };
}

describe("module executeCommand against mock-foundry", () => {
  it("creates and reads back an Actor", async () => {
    const { mock, api, context } = setup();
    const res = await executeCommand(
      env({ command: { action: "create", documentType: "Actor", data: { name: "Bob" } } }),
      api,
      context,
    );
    expect(res.ok).toBe(true);
    expect(mock.documents("Actor").length).toBe(1);
  });

  it("maps a NOT_FOUND from the api into a structured error", async () => {
    const { api, context } = setup();
    const res = await executeCommand(
      env({ command: { action: "update", documentType: "Actor", id: "nope", data: { name: "x" } } }),
      api,
      context,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("enforces the GM-only guard", async () => {
    const { api, context } = setup({ isGM: false });
    const res = await executeCommand(
      env({ command: { action: "create", documentType: "Actor", data: {} } }),
      api,
      context,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AUTH");
  });

  it("enforces a configured token", async () => {
    const { api, context } = setup({ expectedToken: "s3cret" });
    const bad = await executeCommand(
      env({ command: { action: "create", documentType: "Actor", data: {} } }),
      api,
      context,
    );
    expect(bad.ok).toBe(false);
    const good = await executeCommand(
      env({ token: "s3cret", command: { action: "create", documentType: "Actor", data: { name: "ok" } } }),
      api,
      context,
    );
    expect(good.ok).toBe(true);
  });

  it("rejects a protocol-version mismatch", async () => {
    const { api, context } = setup();
    const res = await executeCommand(
      { id: "e1", protocolVersion: "999" as typeof PROTOCOL_VERSION, dryRun: false, command: { action: "find", documentType: "Actor" } },
      api,
      context,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION");
  });

  it("does not persist on dry-run", async () => {
    const { mock, api, context } = setup();
    const res = await executeCommand(
      env({ dryRun: true, command: { action: "create", documentType: "Scene", data: { name: "Ghost" } } }),
      api,
      context,
    );
    expect(res.ok).toBe(true);
    expect(mock.documents("Scene").length).toBe(0);
  });

  it("round-trips embedded token CRUD", async () => {
    const { mock, api, context } = setup();
    await mock.execute(env({ command: { action: "create", documentType: "Scene", data: { _id: "s1", name: "Map" }, keepId: true } }));
    const created = await executeCommand(
      env({
        command: {
          action: "createEmbedded",
          parentType: "Scene",
          parentId: "s1",
          embeddedName: "Token",
          data: [{ name: "Goblin", x: 0, y: 0 }],
        },
      }),
      api,
      context,
    );
    expect(created.ok).toBe(true);
    const scene = mock.documents("Scene")[0] as { tokens: unknown[] };
    expect(scene.tokens.length).toBe(1);
  });

  it("returns world info via getWorldInfo", async () => {
    const { api, context } = setup();
    const res = await executeCommand(
      env({ command: { action: "getWorldInfo" } }),
      api,
      context,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as any).system.id).toBe("dnd5e");
  });
});
