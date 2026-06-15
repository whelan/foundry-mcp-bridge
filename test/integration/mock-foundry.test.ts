import { describe, it, expect } from "vitest";
import {
  type Command,
  type CommandEnvelope,
  PROTOCOL_VERSION,
} from "@foundry-mcp-bridge/shared";
import {
  MockFoundry,
  documentKey,
  embeddedKey,
  expandObject,
  applyUpdate,
} from "./mock-foundry.js";

let counter = 0;
function envelope(command: Command, extra: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    id: `env-${counter++}`,
    protocolVersion: PROTOCOL_VERSION,
    dryRun: false,
    command,
    ...extra,
  };
}

describe("key conventions", () => {
  it("formats top-level and embedded keys", () => {
    expect(documentKey("Actor", "abc")).toBe("!actors!abc");
    expect(documentKey("Scene", "s1")).toBe("!scenes!s1");
    expect(embeddedKey("Scene", "Token", "s1", "t1")).toBe("!scenes.tokens!s1.t1");
  });
});

describe("object helpers", () => {
  it("expandObject expands dot-notation", () => {
    expect(expandObject({ "system.hp.value": 5, name: "x" })).toEqual({
      system: { hp: { value: 5 } },
      name: "x",
    });
  });

  it("applyUpdate deep-merges without mutating the original", () => {
    const doc = { name: "a", system: { hp: { value: 1, max: 10 } } };
    const updated = applyUpdate(doc, { "system.hp.value": 7 });
    expect(updated.system).toEqual({ hp: { value: 7, max: 10 } });
    expect(doc.system.hp.value).toBe(1);
  });
});

describe("create / find / update / delete", () => {
  it("creates an Actor and stores it under the Foundry key", async () => {
    const f = new MockFoundry();
    const res = await f.execute(
      envelope({ action: "create", documentType: "Actor", data: { name: "Bob" } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const doc = res.data as { _id: string; name: string };
      expect(doc.name).toBe("Bob");
      expect(f.store.has(documentKey("Actor", doc._id))).toBe(true);
    }
  });

  it("creates a Folder (for organizing imports) under the folders key", async () => {
    const f = new MockFoundry();
    const res = await f.execute(
      envelope({
        action: "create",
        documentType: "Folder",
        data: { _id: "fld1", name: "NPCs", type: "Actor" },
      }),
    );
    expect(res.ok).toBe(true);
    expect(documentKey("Folder", "fld1")).toBe("!folders!fld1");
    expect(f.store.has(documentKey("Folder", "fld1"))).toBe(true);
  });

  it("finds by id and by query", async () => {
    const f = new MockFoundry();
    await f.execute(
      envelope({ action: "create", documentType: "Actor", data: { _id: "a1", name: "Bob", type: "npc" } }),
    );
    await f.execute(
      envelope({ action: "create", documentType: "Actor", data: { _id: "a2", name: "Sue", type: "pc" } }),
    );

    const byId = await f.execute(envelope({ action: "find", documentType: "Actor", id: "a1" }));
    expect(byId.ok && (byId.data as { name: string }).name).toBe("Bob");

    const byQuery = await f.execute(
      envelope({ action: "find", documentType: "Actor", query: { type: "pc" } }),
    );
    expect(byQuery.ok && (byQuery.data as unknown[]).length).toBe(1);
  });

  it("updates with dot-notation and reports NOT_FOUND otherwise", async () => {
    const f = new MockFoundry();
    await f.execute(
      envelope({ action: "create", documentType: "Actor", data: { _id: "a1", name: "Bob", system: { hp: { value: 1 } } } }),
    );
    const res = await f.execute(
      envelope({ action: "update", documentType: "Actor", id: "a1", data: { "system.hp.value": 9 } }),
    );
    expect(res.ok && (res.data as { system: { hp: { value: number } } }).system.hp.value).toBe(9);

    const missing = await f.execute(
      envelope({ action: "update", documentType: "Actor", id: "nope", data: { name: "x" } }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("deletes a document", async () => {
    const f = new MockFoundry();
    await f.execute(envelope({ action: "create", documentType: "Scene", data: { _id: "s1", name: "Map" } }));
    const res = await f.execute(envelope({ action: "delete", documentType: "Scene", id: "s1" }));
    expect(res.ok).toBe(true);
    expect(f.store.has(documentKey("Scene", "s1"))).toBe(false);
  });
});

describe("embedded documents", () => {
  it("creates, updates and deletes embedded tokens on a scene", async () => {
    const f = new MockFoundry();
    await f.execute(envelope({ action: "create", documentType: "Scene", data: { _id: "s1", name: "Map" } }));

    const created = await f.execute(
      envelope({
        action: "createEmbedded",
        parentType: "Scene",
        parentId: "s1",
        embeddedName: "Token",
        data: [{ _id: "t1", name: "Goblin", x: 0, y: 0 }],
      }),
    );
    expect(created.ok).toBe(true);
    const scene = f.store.get(documentKey("Scene", "s1")) as { tokens: unknown[] };
    expect(scene.tokens.length).toBe(1);

    await f.execute(
      envelope({
        action: "updateEmbedded",
        parentType: "Scene",
        parentId: "s1",
        embeddedName: "Token",
        data: [{ _id: "t1", x: 100 }],
      }),
    );
    expect((scene.tokens[0] as { x: number }).x).toBe(100);

    const del = await f.execute(
      envelope({
        action: "deleteEmbedded",
        parentType: "Scene",
        parentId: "s1",
        embeddedName: "Token",
        ids: ["t1"],
      }),
    );
    expect(del.ok).toBe(true);
    expect(scene.tokens.length).toBe(0);
  });

  it("creates and updates JournalEntryPage documents on a journal (v10+ pages)", async () => {
    const f = new MockFoundry();
    await f.execute(
      envelope({ action: "create", documentType: "JournalEntry", data: { _id: "j1", name: "Lore" } }),
    );

    // Pages map to the `pages` collection, not `journalentrypage`.
    expect(embeddedKey("JournalEntry", "JournalEntryPage", "j1", "p1")).toBe(
      "!journal.pages!j1.p1",
    );

    const created = await f.execute(
      envelope({
        action: "createEmbedded",
        parentType: "JournalEntry",
        parentId: "j1",
        embeddedName: "JournalEntryPage",
        data: [{ _id: "p1", name: "Intro", type: "text", text: { content: "<p>Hello</p>" } }],
      }),
    );
    expect(created.ok).toBe(true);
    const journal = f.store.get(documentKey("JournalEntry", "j1")) as { pages: unknown[] };
    expect(journal.pages.length).toBe(1);

    await f.execute(
      envelope({
        action: "updateEmbedded",
        parentType: "JournalEntry",
        parentId: "j1",
        embeddedName: "JournalEntryPage",
        data: [{ _id: "p1", text: { content: "<p>Updated</p>" } }],
      }),
    );
    expect((journal.pages[0] as { text: { content: string } }).text.content).toBe(
      "<p>Updated</p>",
    );
  });
});

describe("uploadAsset", () => {
  it("uploads via FilePicker and returns the stored path", async () => {
    const f = new MockFoundry();
    const res = await f.execute(
      envelope({
        action: "uploadAsset",
        source: "data",
        target: "worlds/cos/scenes/",
        filename: "tavern.webp",
        contentBase64: "AAAA",
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { path: string }).path).toBe("worlds/cos/scenes/tavern.webp");
    expect(f.filePicker.uploads.length).toBe(1);
  });

  it("does not write on dry-run but predicts the path", async () => {
    const f = new MockFoundry();
    const res = await f.execute(
      envelope(
        {
          action: "uploadAsset",
          source: "data",
          target: "worlds/cos",
          filename: "x.webp",
          contentBase64: "AAAA",
        },
        { dryRun: true },
      ),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { path: string }).path).toBe("worlds/cos/x.webp");
    expect(f.filePicker.uploads.length).toBe(0);
  });
});

describe("dry-run", () => {
  it("does not persist on dryRun create", async () => {
    const f = new MockFoundry();
    const res = await f.execute(
      envelope(
        { action: "create", documentType: "Actor", data: { name: "Ghost" } },
        { dryRun: true },
      ),
    );
    expect(res.ok).toBe(true);
    expect(f.documents("Actor").length).toBe(0);
  });
});

describe("guards", () => {
  it("rejects non-GM users", async () => {
    const f = new MockFoundry({ isGM: false });
    const res = await f.execute(envelope({ action: "create", documentType: "Actor", data: {} }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AUTH");
  });

  it("rejects a wrong/missing token when one is configured", async () => {
    const f = new MockFoundry({ token: "secret" });
    const bad = await f.execute(envelope({ action: "create", documentType: "Actor", data: {} }));
    expect(bad.ok).toBe(false);
    const good = await f.execute(
      envelope({ action: "create", documentType: "Actor", data: { name: "ok" } }, { token: "secret" }),
    );
    expect(good.ok).toBe(true);
  });
});

describe("injectable failures", () => {
  it("throws a transport error for failNext", async () => {
    const f = new MockFoundry();
    f.failNext("connection lost");
    await expect(
      f.execute(envelope({ action: "find", documentType: "Actor" })),
    ).rejects.toThrow("connection lost");
  });

  it("delays a response for hangNext", async () => {
    const f = new MockFoundry();
    f.hangNext(30);
    const start = Date.now();
    await f.execute(envelope({ action: "find", documentType: "Actor" }));
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("returns an injected protocol error result", async () => {
    const f = new MockFoundry();
    f.injectFailure({ result: { code: "CONFLICT", message: "boom" } });
    const res = await f.execute(envelope({ action: "find", documentType: "Actor" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
  });
});

describe("FilePicker mock", () => {
  it("uploads to both data and forgevtt sources", async () => {
    const f = new MockFoundry();
    const local = await f.filePicker.upload("data", "worlds/test", { name: "map.png" });
    const forge = await f.filePicker.upload("forgevtt", "assets", { name: "token.png" });
    expect(local.path).toBe("worlds/test/map.png");
    expect(forge.path).toBe("assets/token.png");

    const browsed = await f.filePicker.browse("forgevtt", "assets");
    expect(browsed.files).toContain("assets/token.png");
    expect(f.filePicker.uploads.map((u) => u.source)).toEqual(["data", "forgevtt"]);
  });
});
