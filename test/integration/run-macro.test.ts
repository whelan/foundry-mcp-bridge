import { describe, it, expect } from "vitest";
import type { CommandError } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";
import { runRunMacro } from "../../packages/mcp-server/src/tools.js";

function setup(allowMacros = true) {
  const mock = new MockFoundry({ allowMacros });
  const transport = new MockTransport(mock);
  mock.store.set("!macros!m1", { _id: "m1", name: "UO Puzzles: Build", type: "script", command: "return 1" });
  mock.store.set("!macros!m2", { _id: "m2", name: "Greeting", type: "chat", command: "hi" });
  mock.store.set("!macros!m3", { _id: "m3", name: "Twin", type: "script", command: "" });
  mock.store.set("!macros!m4", { _id: "m4", name: "Twin", type: "script", command: "" });
  return { mock, transport };
}

function expectErr(out: ToolOutcome, code: CommandError["code"]): void {
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error.code).toBe(code);
}

describe("run_macro", () => {
  it("is switched off until a GM turns the setting on, and then runs nothing", async () => {
    const { mock, transport } = setup(false);
    const out = await runRunMacro(transport, { name: "UO Puzzles: Build" });
    expectErr(out, "UNSUPPORTED");
    expect(mock.macroRuns).toEqual([]);
  });

  it("dry-runs, then runs the macro exactly once with args as its scope", async () => {
    const { mock, transport } = setup();
    mock.macroResults.set("UO Puzzles: Build", { passed: 13 });
    const out = await runRunMacro(transport, { name: "UO Puzzles: Build", args: { mode: "test" } });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write"]);
    expect(mock.macroRuns).toEqual([{ id: "m1", name: "UO Puzzles: Build", scope: { mode: "test" } }]);
    if (out.ok) expect(out.data).toEqual({ macroId: "m1", name: "UO Puzzles: Build", ran: true, result: { passed: 13 } });
  });

  it("finds a macro by id", async () => {
    const { mock, transport } = setup();
    expect((await runRunMacro(transport, { id: "m1" })).ok).toBe(true);
    expect(mock.macroRuns.map((r) => r.id)).toEqual(["m1"]);
  });

  it("rejects a missing macro, a non-script macro, a duplicate name and a bad selector", async () => {
    const { mock, transport } = setup();
    expectErr(await runRunMacro(transport, { name: "Nope" }), "NOT_FOUND");
    expectErr(await runRunMacro(transport, { id: "m2" }), "VALIDATION");
    expectErr(await runRunMacro(transport, { name: "Twin" }), "CONFLICT");
    expectErr(await runRunMacro(transport, {}), "VALIDATION");
    expectErr(await runRunMacro(transport, { id: "m1", name: "UO Puzzles: Build" }), "VALIDATION");
    expect(mock.macroRuns).toEqual([]);
  });

  it("is refused for a non-GM client before anything runs", async () => {
    const { mock, transport } = setup();
    mock.isGM = false;
    expectErr(await runRunMacro(transport, { id: "m1" }), "AUTH");
    expect(mock.macroRuns).toEqual([]);
  });
});
