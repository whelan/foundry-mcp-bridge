import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandPermission, levelAllows, type Command } from "@foundry-mcp-bridge/shared";
import { MockFoundry, type MockFoundryOptions } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { ChangeLog } from "../../packages/mcp-server/src/change-log.js";
import { runListChanges, runUndoChange } from "../../packages/mcp-server/src/change-tools.js";
import {
  runCreateDocument,
  runUpdateDocument,
  runDeleteDocument,
  runCreateEmbedded,
  runUpdateEmbedded,
  runDeleteEmbedded,
  runFindDocuments,
} from "../../packages/mcp-server/src/tools.js";
import type { PipelineOptions, ToolOutcome } from "../../packages/mcp-server/src/reliability.js";

function setup(options: MockFoundryOptions = {}, file?: string) {
  const mock = new MockFoundry(options);
  const transport = new MockTransport(mock);
  const log = new ChangeLog(file);
  let n = 0;
  /** Options for one simulated tool call; pass the same `request` to group calls. */
  const call = (tool: string, request = `req${++n}`): PipelineOptions => ({ changes: { log, requestId: request, tool, warnings: [] } });
  return { mock, transport, log, call };
}

const code = (out: ToolOutcome) => (out.ok ? "ok" : out.error.code);
const seedScene = (mock: MockFoundry) =>
  mock.store.set("!scenes!s1", { _id: "s1", name: "Crypt", grid: { type: 1, size: 100 }, tokens: [{ _id: "t1", name: "Goblin", x: 0, y: 0 }, { _id: "t2", name: "Orc", x: 5, y: 5 }] });

describe("permissions", () => {
  it("maps commands to a category and operation", () => {
    const need = (c: Command) => commandPermission(c);
    expect(need({ action: "delete", documentType: "Actor", id: "a" })).toEqual({ category: "actors", op: "delete" });
    expect(need({ action: "createEmbedded", parentType: "Scene", parentId: "s", embeddedName: "Token", data: [{}] })).toEqual({ category: "scenes", op: "create" });
    expect(need({ action: "deleteQuest", id: "q" })).toEqual({ category: "journals", op: "delete" });
    expect(need({ action: "find", documentType: "Actor" })).toBeNull();
    expect(levelAllows("no-delete", "update")).toBe(true);
    expect(levelAllows("no-delete", "delete")).toBe(false);
    expect(levelAllows("read-only", "create")).toBe(false);
  });

  it("refuses writes above the GM's level with FORBIDDEN, even on dry-run, and never changes state", async () => {
    const { mock, transport } = setup({ permissions: { actors: "no-delete", scenes: "read-only", journals: "full" } });
    seedScene(mock);
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob", type: "npc" });
    mock.store.set("!journal!j1", { _id: "j1", name: "Notes" });

    expect(code(await runCreateDocument(transport, { documentType: "Actor", data: { name: "New" } }))).toBe("ok");
    expect(code(await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { name: "Bobby" } }))).toBe("ok");

    const del = await runDeleteDocument(transport, { documentType: "Actor", id: "a1" });
    expect(code(del)).toBe("FORBIDDEN");
    expect(!del.ok && del.error.message).toContain("Bridge permission: actors");
    expect(del.steps).toEqual(["dry-run"]); // refused at the dry-run, before any write
    expect(mock.store.has("!actors!a1")).toBe(true);

    const token = await runCreateEmbedded(transport, { parentType: "Scene", parentId: "s1", embeddedName: "Token", data: [{ name: "X" }] });
    expect(code(token)).toBe("FORBIDDEN");
    expect((mock.store.get("!scenes!s1") as any).tokens).toHaveLength(2);

    expect(code(await runDeleteDocument(transport, { documentType: "JournalEntry", id: "j1" }))).toBe("ok");
    expect(code(await runFindDocuments(transport, { documentType: "Scene" }))).toBe("ok"); // reads are never gated
  });

  it("reflects a GM changing the setting at once", async () => {
    const { mock, transport } = setup({ permissions: { actors: "no-delete" } });
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    expect(code(await runDeleteDocument(transport, { documentType: "Actor", id: "a1" }))).toBe("FORBIDDEN");
    mock.permissions.actors = "full";
    expect(code(await runDeleteDocument(transport, { documentType: "Actor", id: "a1" }))).toBe("ok");
  });
});

describe("change log and undo", () => {
  it("undoes an update by restoring the previous values", async () => {
    const { mock, transport, log, call } = setup();
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob", system: { hp: 10 } });
    await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { name: "Bobby", "system.hp": 3 } }, call("update_document"));
    expect(mock.store.get("!actors!a1")).toMatchObject({ name: "Bobby", system: { hp: 3 } });

    const listed = await runListChanges(log, transport, {});
    expect(listed.ok && (listed.data as any[])[0]).toMatchObject({ tool: "update_document", summary: "update Actor a1", undoable: true });
    const id = (listed.ok && (listed.data as any[])[0].id) as string;

    const undone = await runUndoChange(log, transport, { id }, call("undo_change"));
    expect(undone.ok).toBe(true);
    expect(mock.store.get("!actors!a1")).toMatchObject({ name: "Bob", system: { hp: 10 } });
    // already undone: refused, and hidden from the default listing
    expect(code(await runUndoChange(log, transport, { id }, call("undo_change")))).toBe("VALIDATION");
    const after = await runListChanges(log, transport, { tool: "update_document" });
    expect(after.ok && after.data).toEqual([]);
  });

  it("undoes a create by deleting it and a delete by re-creating it with the same id", async () => {
    const { mock, transport, log, call } = setup();
    const created = await runCreateDocument(transport, { documentType: "Actor", data: { name: "Ghoul" } }, call("create_document"));
    const actorId = (created.ok && (created.data as any)._id) as string;
    expect(mock.store.has(`!actors!${actorId}`)).toBe(true);
    await runUndoChange(log, transport, { id: log.list({ tool: "create_document" })[0]!.id }, call("undo_change"));
    expect(mock.store.has(`!actors!${actorId}`)).toBe(false);

    mock.store.set("!actors!a9", { _id: "a9", name: "Lich", system: { cr: 21 }, _stats: { createdTime: 1, modifiedTime: 2 } });
    await runDeleteDocument(transport, { documentType: "Actor", id: "a9" }, call("delete_document"));
    expect(mock.store.has("!actors!a9")).toBe(false);
    const out = await runUndoChange(log, transport, { id: log.list({ tool: "delete_document" })[0]!.id }, call("undo_change"));
    expect(out.ok).toBe(true);
    expect(mock.store.get("!actors!a9")).toMatchObject({ _id: "a9", name: "Lich", system: { cr: 21 } });
  });

  it("undoes embedded updates, creates and deletes", async () => {
    const { mock, transport, log, call } = setup();
    seedScene(mock);
    const tokens = () => (mock.store.get("!scenes!s1") as any).tokens as any[];

    await runUpdateEmbedded(transport, { parentType: "Scene", parentId: "s1", embeddedName: "Token", data: [{ _id: "t1", x: 300 }] }, call("update_embedded"));
    await runUndoChange(log, transport, { id: log.list({ tool: "update_embedded" })[0]!.id }, call("undo_change"));
    expect(tokens().find((t) => t._id === "t1").x).toBe(0);

    await runCreateEmbedded(transport, { parentType: "Scene", parentId: "s1", embeddedName: "Token", data: [{ name: "Bat" }] }, call("create_embedded"));
    expect(tokens()).toHaveLength(3);
    await runUndoChange(log, transport, { id: log.list({ tool: "create_embedded" })[0]!.id }, call("undo_change"));
    expect(tokens()).toHaveLength(2);

    await runDeleteEmbedded(transport, { parentType: "Scene", parentId: "s1", embeddedName: "Token", ids: ["t2"] }, call("delete_embedded"));
    expect(tokens().map((t) => t.name)).toEqual(["Goblin"]);
    await runUndoChange(log, transport, { id: log.list({ tool: "delete_embedded" })[0]!.id }, call("undo_change"));
    expect(tokens().map((t) => t.name).sort()).toEqual(["Goblin", "Orc"]);
  });

  it("undoes a whole tool call by requestId, newest first", async () => {
    const { mock, transport, log, call } = setup();
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    const opts = call("import_npc", "one-request");
    const created = await runCreateDocument(transport, { documentType: "Actor", data: { name: "Hench" } }, opts);
    await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { name: "Renamed" } }, opts);
    await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { name: "Renamed again" } }, opts);

    const out = await runUndoChange(log, transport, { requestId: "one-request" }, call("undo_change"));
    expect(out.ok && (out.data as any).undone).toHaveLength(3);
    expect(mock.store.get("!actors!a1")).toMatchObject({ name: "Bob" });
    expect(mock.store.has(`!actors!${(created.ok && (created.data as any)._id) as string}`)).toBe(false);
  });

  it("stops and keeps the entry when the GM's permissions forbid the undo", async () => {
    const { mock, transport, log, call } = setup({ permissions: { actors: "no-delete" } });
    const created = await runCreateDocument(transport, { documentType: "Actor", data: { name: "Ghoul" } }, call("create_document"));
    const entry = log.list()[0]!;
    const out = await runUndoChange(log, transport, { id: entry.id }, call("undo_change"));
    expect(!out.ok && out.error.message).toContain("FORBIDDEN");
    expect(log.get(entry.id)!.undone).toBeUndefined();
    expect(mock.store.has(`!actors!${(created.ok && (created.data as any)._id) as string}`)).toBe(true);
  });

  it("does not log dry-runs, failed writes or reads", async () => {
    const { mock, transport, log, call } = setup({ permissions: { actors: "read-only" } });
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { name: "X" } }, call("update_document"));
    await runFindDocuments(transport, { documentType: "Actor" }, call("find_documents"));
    expect(log.list()).toEqual([]);
  });

  it("persists across restarts, including which entries were undone", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "changes-")), "nested", "changes.jsonl");
    const a = setup({}, file);
    a.mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    await runUpdateDocument(a.transport, { documentType: "Actor", id: "a1", data: { name: "One" } }, a.call("update_document"));
    await runUpdateDocument(a.transport, { documentType: "Actor", id: "a1", data: { name: "Two" } }, a.call("update_document"));
    await runUndoChange(a.log, a.transport, { id: a.log.list()[0]!.id }, a.call("undo_change"));

    const reloaded = new ChangeLog(file);
    const rows = reloaded.list({ includeUndone: true, tool: "update_document" });
    expect(rows.map((r) => Boolean(r.undone))).toEqual([true, false]);
    expect(reloaded.list({ tool: "update_document" })).toHaveLength(1);
  });

  it("reports UNSUPPORTED when the log is switched off", async () => {
    const { transport } = setup();
    expect(code(await runListChanges(null, transport, {}))).toBe("UNSUPPORTED");
    expect(code(await runUndoChange(null, transport, { id: "x" }))).toBe("UNSUPPORTED");
  });
});
