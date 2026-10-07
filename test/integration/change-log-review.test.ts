import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockFoundry, type MockFoundryOptions } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { ChangeLog } from "../../packages/mcp-server/src/change-log.js";
import { runListChanges, runUndoChange } from "../../packages/mcp-server/src/change-tools.js";
import {
  runCreateDocument,
  runCreateEmbedded,
  runDeleteDocument,
  runUpdateDocument,
  runUpdateEmbedded,
} from "../../packages/mcp-server/src/tools.js";
import type { PipelineOptions, ToolOutcome } from "../../packages/mcp-server/src/reliability.js";

const tmp = () => mkdtempSync(join(tmpdir(), "changes-review-"));

function world(options: MockFoundryOptions = {}, log = new ChangeLog()) {
  const mock = new MockFoundry(options);
  const transport = new MockTransport(mock);
  let n = 0;
  const call = (tool: string): PipelineOptions => ({ changes: { log, requestId: `r${++n}`, tool, warnings: [] } });
  return { mock, transport, log, call };
}

const errorOf = (out: ToolOutcome) => (out.ok ? null : out.error);
const seedScene = (mock: MockFoundry) =>
  mock.store.set("!scenes!s1", { _id: "s1", name: "Crypt", tokens: [{ _id: "t1", name: "Goblin", x: 0 }] });

describe("rollback under the GM's permissions", () => {
  it("says so when the default no-delete level refuses the rollback of a create", async () => {
    const { mock, transport } = world({ permissions: { actors: "no-delete" } });
    transport.corruptReadBack = true;
    const out = await runCreateDocument(transport, { documentType: "Actor", data: { name: "Bob" } });
    const error = errorOf(out)!;
    expect(error.code).toBe("READBACK_MISMATCH");
    expect(error.message).toContain("rollback was refused");
    expect(error.message).not.toContain("rolled back");
    expect(error.details).toMatchObject({ rollbackError: { code: "FORBIDDEN" }, remaining: { documentType: "Actor" } });
    expect(out.steps).toEqual(expect.arrayContaining(["rollback", "rollback-failed"]));
    const id = (error.details as any).remaining.id;
    expect(mock.store.has(`!actors!${id}`)).toBe(true); // the document really is still there
  });

  it("still rolls back (and says so) when delete is allowed", async () => {
    const { mock, transport } = world({ permissions: { actors: "full" } });
    transport.corruptReadBack = true;
    const out = await runCreateDocument(transport, { documentType: "Actor", data: { name: "Bob" } });
    expect(errorOf(out)!.message).toContain("rolled back");
    expect(out.steps).not.toContain("rollback-failed");
    expect(mock.documents("Actor")).toHaveLength(0);
  });

  it("reports a refused rollback of an embedded create", async () => {
    const { mock, transport } = world({ permissions: { scenes: "no-delete" } });
    seedScene(mock);
    transport.failFindAtCall = 1; // the read-back
    const out = await runCreateEmbedded(transport, { parentType: "Scene", parentId: "s1", embeddedName: "Token", data: [{ _id: "t9", name: "Bat" }] });
    expect(errorOf(out)!.message).toContain("rollback was refused");
    expect(errorOf(out)!.details).toMatchObject({ rollbackError: { code: "FORBIDDEN" } });
    expect((mock.store.get("!scenes!s1") as any).tokens).toHaveLength(2);
  });

  it("applies the permission in force at rollback time, not at write time", async () => {
    const { mock, transport } = world({ permissions: { actors: "full" } });
    transport.corruptReadBack = true;
    const flipping = Object.assign(Object.create(transport), {
      request: async (envelope: any, opts: any) => {
        const res = await transport.request(envelope, opts);
        if (envelope.command.action === "create" && !envelope.dryRun) mock.permissions.actors = "no-delete"; // GM tightens mid-call
        return res;
      },
    });
    const out = await runCreateDocument(flipping, { documentType: "Actor", data: { name: "Bob" } });
    expect(errorOf(out)!.message).toContain("rollback was refused");
    expect(mock.documents("Actor")).toHaveLength(1);
  });
});

describe("a logging problem never fails a write that went through", () => {
  const brokenLog = () => {
    const dir = tmp();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    return new ChangeLog(join(blocker, "changes.jsonl")); // mkdir under a file always fails
  };

  it("keeps the created id and read-back, and warns instead", async () => {
    const { mock, transport, call } = world({}, brokenLog());
    const opts = call("create_document");
    const out = await runCreateDocument(transport, { documentType: "Actor", data: { name: "Bob" } }, opts);
    expect(out.ok).toBe(true);
    expect(out.steps).toContain("read-back");
    expect((out.ok && (out.data as any)._id) as string).toBeTruthy();
    expect(mock.documents("Actor")).toHaveLength(1);
    expect(opts.changes!.warnings.join(" ")).toContain("could not be written to the change log");
    expect(opts.changes!.warnings.join(" ")).toContain("repeating the call would apply it again");
  });

  it("does the same for update and delete", async () => {
    const { mock, transport, call } = world({}, brokenLog());
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    const upd = call("update_document");
    expect((await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { name: "Bobby" } }, upd)).ok).toBe(true);
    expect(mock.store.get("!actors!a1")).toMatchObject({ name: "Bobby" });
    expect(upd.changes!.warnings).toHaveLength(1);
    const del = call("delete_document");
    expect((await runDeleteDocument(transport, { documentType: "Actor", id: "a1" }, del)).ok).toBe(true);
    expect(mock.store.has("!actors!a1")).toBe(false);
    expect(del.changes!.warnings).toHaveLength(1);
  });

  it("still undoes in this session after a failed file write, and warns if the undone mark cannot be saved", async () => {
    const dir = tmp();
    const file = join(dir, "logs", "changes.jsonl");
    const { mock, transport, log, call } = world({}, new ChangeLog(file));
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { name: "Bobby" } }, call("update_document"));
    rmSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs"), "now a file"); // the log directory can no longer be written
    const out = await runUndoChange(log, transport, { id: log.list()[0]!.id }, call("undo_change"));
    expect(out.ok).toBe(true);
    expect(mock.store.get("!actors!a1")).toMatchObject({ name: "Bob" });
    expect(out.warnings?.join(" ")).toContain("could not be saved");
  });
});

describe("undo is tied to the Foundry world", () => {
  const withWorldKey = (key: string | undefined): MockFoundryOptions => ({
    worldInfo: { world: { id: "shared-world-id", title: "Barovia", ...(key ? { key } : {}) } },
  });

  it("refuses to undo in another world that happens to reuse the same ids", async () => {
    const log = new ChangeLog();
    const a = world(withWorldKey("key-a"), log);
    const b = world(withWorldKey("key-b"), log);
    a.mock.store.set("!actors!sharedActor", { _id: "sharedActor", name: "A original" });
    b.mock.store.set("!actors!sharedActor", { _id: "sharedActor", name: "B precious" });
    await runUpdateDocument(a.transport, { documentType: "Actor", id: "sharedActor", data: { name: "A changed" } }, a.call("update_document"));
    const id = log.list()[0]!.id;

    const wrong = await runUndoChange(log, b.transport, { id }, b.call("undo_change"));
    expect(errorOf(wrong)!.code).toBe("CONFLICT");
    expect(b.mock.store.get("!actors!sharedActor")).toMatchObject({ name: "B precious" });

    const listedInB = await runListChanges(log, b.transport, {});
    expect(listedInB.ok && listedInB.data).toEqual([]);
    const all = await runListChanges(log, b.transport, { allWorlds: true });
    expect(all.ok && (all.data as any[])[0]).toMatchObject({ undoable: false, world: "other" });

    const right = await runUndoChange(log, a.transport, { id }, a.call("undo_change"));
    expect(right.ok).toBe(true);
    expect(a.mock.store.get("!actors!sharedActor")).toMatchObject({ name: "A original" });
  });

  it("still undoes after a restart in the same world", async () => {
    const file = join(tmp(), "changes.jsonl");
    const first = world(withWorldKey("key-a"), new ChangeLog(file));
    first.mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    await runUpdateDocument(first.transport, { documentType: "Actor", id: "a1", data: { name: "Bobby" } }, first.call("update_document"));

    const reloaded = new ChangeLog(file);
    const second = world(withWorldKey("key-a"), reloaded);
    second.mock.store.set("!actors!a1", { _id: "a1", name: "Bobby" });
    expect((await runUndoChange(reloaded, second.transport, { id: reloaded.list()[0]!.id }, second.call("undo_change"))).ok).toBe(true);
    expect(second.mock.store.get("!actors!a1")).toMatchObject({ name: "Bob" });
  });

  it("never makes entries without a world identity undoable", async () => {
    const log = new ChangeLog();
    const old = world(withWorldKey(undefined), log); // a module too old to report a key
    old.mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    await runUpdateDocument(old.transport, { documentType: "Actor", id: "a1", data: { name: "Bobby" } }, old.call("update_document"));
    expect(log.list()[0]!.worldKey).toBeUndefined();

    const current = world(withWorldKey("key-a"), log);
    current.mock.store.set("!actors!a1", { _id: "a1", name: "Bobby" });
    const out = await runUndoChange(log, current.transport, { id: log.list()[0]!.id }, current.call("undo_change"));
    expect(errorOf(out)!.code).toBe("UNSUPPORTED");
    expect(current.mock.store.get("!actors!a1")).toMatchObject({ name: "Bobby" });
    const all = await runListChanges(log, current.transport, { allWorlds: true });
    expect(all.ok && (all.data as any[])[0]).toMatchObject({ undoable: false, world: "unknown" });
  });
});

describe("undo restores what existed — and removes what did not", () => {
  async function updateThenUndo(before: Record<string, unknown>, data: Record<string, unknown>) {
    const { mock, transport, log, call } = world();
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob", ...before });
    expect((await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data }, call("update_document"))).ok).toBe(true);
    const out = await runUndoChange(log, transport, { id: log.list()[0]!.id }, call("undo_change"));
    expect(out.ok).toBe(true);
    return mock.store.get("!actors!a1") as any;
  }

  it("removes a newly added dot-path field instead of leaving null", async () => {
    const doc = await updateThenUndo({ flags: { demo: { old: 1 } } }, { "flags.demo.new": 2 });
    expect(doc.flags.demo).toEqual({ old: 1 });
  });

  it("removes a newly added nested field", async () => {
    const doc = await updateThenUndo({ flags: { demo: { old: 1 } } }, { flags: { demo: { new: 2 } } });
    expect(doc.flags.demo).toEqual({ old: 1 });
  });

  it("removes missing ancestors entirely", async () => {
    const doc = await updateThenUndo({}, { "flags.demo.new": 2 });
    expect("flags" in doc).toBe(false);
  });

  it("keeps an explicit null a null", async () => {
    const doc = await updateThenUndo({ flags: { a: null } }, { "flags.a": 5 });
    expect(doc.flags).toEqual({ a: null });
  });

  it("restores arrays and existing values", async () => {
    const doc = await updateThenUndo({ tags: ["x", "y"], system: { hp: 10 } }, { tags: ["z"], "system.hp": 3 });
    expect(doc).toMatchObject({ tags: ["x", "y"], system: { hp: 10 } });
  });

  it("undoes embedded updates that added fields", async () => {
    const { mock, transport, log, call } = world();
    seedScene(mock);
    await runUpdateEmbedded(transport, { parentType: "Scene", parentId: "s1", embeddedName: "Token", data: [{ _id: "t1", x: 300, "flags.mark": 1 }] }, call("update_embedded"));
    expect((mock.store.get("!scenes!s1") as any).tokens[0]).toMatchObject({ x: 300, flags: { mark: 1 } });
    expect((await runUndoChange(log, transport, { id: log.list()[0]!.id }, call("undo_change"))).ok).toBe(true);
    const token = (mock.store.get("!scenes!s1") as any).tokens[0];
    expect(token.x).toBe(0);
    expect("flags" in token).toBe(false);
  });

  it("uses the same correct inverse when a read-back mismatch rolls an update back", async () => {
    const { mock, transport } = world();
    mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    transport.corruptFindAtCall = 2; // 1 = pre-read, 2 = read-back (stripped)
    const out = await runUpdateDocument(transport, { documentType: "Actor", id: "a1", data: { "flags.demo.new": 2 } });
    expect(errorOf(out)!.code).toBe("READBACK_MISMATCH");
    expect("flags" in (mock.store.get("!actors!a1") as any)).toBe(false);
  });
});

describe("the JSONL log survives torn writes", () => {
  /** A log file holding two real entries. */
  async function seeded() {
    const file = join(tmp(), "changes.jsonl");
    const w = world({}, new ChangeLog(file));
    w.mock.store.set("!actors!a1", { _id: "a1", name: "Bob" });
    await runUpdateDocument(w.transport, { documentType: "Actor", id: "a1", data: { name: "One" } }, w.call("update_document"));
    await runUpdateDocument(w.transport, { documentType: "Actor", id: "a1", data: { name: "Two" } }, w.call("update_document"));
    return { file, ...w };
  }
  const append = async (file: string) => {
    const w = world({}, new ChangeLog(file));
    w.mock.store.set("!actors!a1", { _id: "a1", name: "Two" });
    await runUpdateDocument(w.transport, { documentType: "Actor", id: "a1", data: { name: "Three" } }, w.call("update_document"));
  };

  it("plain restart keeps everything", async () => {
    const { file } = await seeded();
    expect(new ChangeLog(file).list()).toHaveLength(2);
  });

  it("keeps earlier entries and the next one after a torn last line", async () => {
    const { file } = await seeded();
    appendFileSync(file, '{"kind":"entry","id":"half'); // crash mid-write, no newline
    await append(file);
    expect(new ChangeLog(file).list().map((e) => e.summary)).toHaveLength(3);
  });

  it("keeps a valid last entry that lost only its newline", async () => {
    const { file } = await seeded();
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, ""));
    await append(file);
    expect(new ChangeLog(file).list()).toHaveLength(3);
  });

  it("ignores a torn undone marker and accepts a later one", async () => {
    const { file, log, transport, call } = await seeded();
    appendFileSync(file, '{"kind":"undone","id":"');
    const reloaded = new ChangeLog(file);
    expect(reloaded.list()).toHaveLength(2);
    reloaded.markUndone(reloaded.list()[0]!.id, "test");
    expect(new ChangeLog(file).list()).toHaveLength(1);
    void log; void transport; void call;
  });

  it("skips lines that are valid JSON but not a valid record", async () => {
    const { file } = await seeded();
    appendFileSync(file, '{"kind":"entry","id":"x"}\n{"kind":"entry","id":"y","ts":"t","requestId":"r","tool":"t","summary":"s","undo":{"action":"explode"}}\n');
    expect(new ChangeLog(file).list()).toHaveLength(2);
  });
});
