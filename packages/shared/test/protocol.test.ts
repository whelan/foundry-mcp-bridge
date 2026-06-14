import { describe, it, expect } from "vitest";
import { Command, CommandEnvelope, CommandResult } from "../src/protocol.js";

describe("Command", () => {
  it("parses a create_document command", () => {
    const parsed = Command.parse({
      type: "create_document",
      documentType: "Actor",
      data: { name: "Strahd", type: "npc" },
    });
    expect(parsed.type).toBe("create_document");
  });

  it("parses an update_document diff", () => {
    const parsed = Command.parse({
      type: "update_document",
      documentType: "Actor",
      name: "Strahd",
      changes: { "system.attributes.ac.flat": 18 },
    });
    expect(parsed.type).toBe("update_document");
  });

  it("rejects an unknown document type", () => {
    expect(() =>
      Command.parse({ type: "create_document", documentType: "Spaceship", data: {} }),
    ).toThrow();
  });

  it("rejects an unknown command type", () => {
    expect(() => Command.parse({ type: "teleport", data: {} })).toThrow();
  });
});

describe("CommandEnvelope / CommandResult", () => {
  it("round-trips an envelope with a correlation id", () => {
    const env = CommandEnvelope.parse({
      requestId: "req-1",
      command: { type: "find_document", documentType: "JournalEntry", name: "Lejren" },
    });
    expect(env.requestId).toBe("req-1");
  });

  it("accepts a structured failure result", () => {
    const res = CommandResult.parse({
      requestId: "req-1",
      ok: false,
      stage: "validate",
      reason: "missing required field 'name'",
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("validate");
  });
});
