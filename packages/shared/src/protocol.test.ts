import { describe, it, expect } from "vitest";
import {
  Command,
  CommandEnvelope,
  CommandResult,
  PROTOCOL_VERSION,
  ok,
  err,
} from "./protocol.js";

describe("CommandEnvelope", () => {
  it("parses a valid create envelope and applies defaults", () => {
    const parsed = CommandEnvelope.parse({
      id: "abc",
      command: { action: "create", documentType: "Actor", data: { name: "Bob" } },
    });
    expect(parsed.dryRun).toBe(false);
    expect(parsed.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(parsed.command.action).toBe("create");
  });

  it("rejects an unknown action", () => {
    const result = Command.safeParse({ action: "explode", documentType: "Actor" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid documentType", () => {
    const result = Command.safeParse({
      action: "create",
      documentType: "Dragon",
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("update / embedded commands", () => {
  it("requires a non-empty id on update", () => {
    const result = Command.safeParse({
      action: "update",
      documentType: "Actor",
      id: "",
      data: { name: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("requires _id on each updateEmbedded entry", () => {
    const missing = Command.safeParse({
      action: "updateEmbedded",
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ name: "no id" }],
    });
    expect(missing.success).toBe(false);

    const present = Command.safeParse({
      action: "updateEmbedded",
      parentType: "Scene",
      parentId: "s1",
      embeddedName: "Token",
      data: [{ _id: "t1", name: "ok" }],
    });
    expect(present.success).toBe(true);
  });
});

describe("CommandResult helpers", () => {
  it("ok() builds a parseable success result", () => {
    const r = ok("id1", { _id: "x" });
    expect(CommandResult.parse(r)).toEqual(r);
    expect(r.ok).toBe(true);
  });

  it("err() carries code, message and details", () => {
    const r = err("id1", "NOT_FOUND", "missing", { id: "x" });
    const parsed = CommandResult.parse(r);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("NOT_FOUND");
      expect(parsed.error.details).toEqual({ id: "x" });
    }
  });
});
