import { describe, it, expect } from "vitest";
import type { CommandEnvelope } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import {
  type RelayTransport,
  type RequestOptions,
  withTimeout,
} from "../../packages/mcp-server/src/relay-transport.js";
import {
  runCreateDocument,
  runCreateScene,
  runUpdateDocument,
  runDuplicateDocument,
  runCreateQuest,
  runUpdateQuest,
  runDeleteQuest,
} from "../../packages/mcp-server/src/tools.js";

/** Transport that drives the mock-foundry, with hooks to exercise the pipeline. */
class MockTransport implements RelayTransport {
  corruptReadBack = false;
  constructor(private readonly mock: MockFoundry) {}

  async request(envelope: CommandEnvelope, opts?: RequestOptions) {
    const exec = (async () => {
      const res = await this.mock.execute(envelope);
      if (
        this.corruptReadBack &&
        envelope.command.action === "find" &&
        res.ok &&
        !envelope.dryRun
      ) {
        this.corruptReadBack = false;
        // Strip everything but the id so read-back verification fails.
        return { id: res.id, ok: true as const, data: { _id: (res.data as { _id: string })._id } };
      }
      return res;
    })();
    return opts?.timeoutMs ? withTimeout(exec, opts.timeoutMs) : exec;
  }

  close(): void {}
}

function setup() {
  const mock = new MockFoundry();
  const transport = new MockTransport(mock);
  return { mock, transport };
}

describe("create_document pipeline", () => {
  it("validates, writes and reads back an Actor", async () => {
    const { mock, transport } = setup();
    const out = await runCreateDocument(transport, {
      documentType: "Actor",
      data: { name: "Bob", type: "npc" },
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write", "read-back"]);
    expect(mock.documents("Actor").length).toBe(1);
  });

  it("rolls back when read-back does not match", async () => {
    const { mock, transport } = setup();
    transport.corruptReadBack = true;
    const out = await runCreateDocument(transport, {
      documentType: "Actor",
      data: { name: "Bob" },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // The created document was deleted by the rollback.
    expect(mock.documents("Actor").length).toBe(0);
  });

  it("surfaces a TIMEOUT as a structured error", async () => {
    const { mock, transport } = setup();
    mock.hangNext(50);
    const out = await runCreateDocument(
      transport,
      { documentType: "Actor", data: { name: "Slow" } },
      { timeoutMs: 10 },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("TIMEOUT");
  });
});

describe("create_scene pipeline", () => {
  it("builds a V14 scene and persists it", async () => {
    const { mock, transport } = setup();
    const out = await runCreateScene(transport, { name: "Tavern", gridSize: 70 });
    expect(out.ok).toBe(true);
    const scene = mock.documents("Scene")[0] as { name: string; grid: { size: number } };
    expect(scene.name).toBe("Tavern");
    expect(scene.grid.size).toBe(70);
  });
});

describe("update_document pipeline", () => {
  it("updates with dot-notation and verifies the change", async () => {
    const { mock, transport } = setup();
    await mock.execute({
      id: "seed",
      protocolVersion: "1",
      dryRun: false,
      command: { action: "create", documentType: "Actor", data: { _id: "a1", name: "Bob", system: { hp: { value: 1 } } } },
    });
    const out = await runUpdateDocument(transport, {
      documentType: "Actor",
      id: "a1",
      data: { "system.hp.value": 9 },
    });
    expect(out.ok).toBe(true);
    const actor = mock.documents("Actor")[0] as { system: { hp: { value: number } } };
    expect(actor.system.hp.value).toBe(9);
  });

  it("returns NOT_FOUND for a missing document", async () => {
    const { transport } = setup();
    const out = await runUpdateDocument(transport, {
      documentType: "Actor",
      id: "ghost",
      data: { name: "x" },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("NOT_FOUND");
  });
});

describe("duplicate_document pipeline", () => {
  async function seedGoblin(mock: MockFoundry) {
    await mock.execute({
      id: "seed",
      protocolVersion: "1",
      dryRun: false,
      command: {
        action: "create",
        documentType: "Actor",
        data: { _id: "g1", name: "Goblin", system: { hp: { value: 7 } } },
      },
    });
  }

  it("clones a document with overrides, leaving the original intact", async () => {
    const { mock, transport } = setup();
    await seedGoblin(mock);
    const out = await runDuplicateDocument(transport, {
      documentType: "Actor",
      id: "g1",
      overrides: { name: "Goblin Boss" },
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write", "read-back"]);
    const actors = mock.documents("Actor") as Array<{ name: string; system: { hp: { value: number } } }>;
    expect(actors.length).toBe(2);
    const names = actors.map((a) => a.name).sort();
    expect(names).toEqual(["Goblin", "Goblin Boss"]);
    // The copy inherited the source's nested data.
    const copy = actors.find((a) => a.name === "Goblin Boss")!;
    expect(copy.system.hp.value).toBe(7);
  });

  it("returns NOT_FOUND when the source does not exist", async () => {
    const { transport } = setup();
    const out = await runDuplicateDocument(transport, { documentType: "Actor", id: "ghost" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("NOT_FOUND");
  });

  it("rolls back the copy when read-back does not match the overrides", async () => {
    const { mock, transport } = setup();
    await seedGoblin(mock);
    transport.corruptReadBack = true;
    const out = await runDuplicateDocument(transport, {
      documentType: "Actor",
      id: "g1",
      overrides: { name: "Goblin Boss" },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    // Only the original survives; the rolled-back copy is gone.
    expect(mock.documents("Actor").length).toBe(1);
  });
});

describe("quest pipeline", () => {
  it("creates a quest with name and status", async () => {
    const { mock, transport } = setup();
    const out = await runCreateQuest(transport, {
      data: { name: "Slay the Dragon", status: "active" },
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toContain("write");
    const quests = Array.from(mock.quests.values());
    expect(quests.length).toBe(1);
    const quest = quests[0] as { name: string; status: string };
    expect(quest.name).toBe("Slay the Dragon");
    expect(quest.status).toBe("active");
  });

  it("creates a sub-quest with parentId reference", async () => {
    const { mock, transport } = setup();
    // Create parent quest
    const parentOut = await runCreateQuest(transport, {
      data: { name: "Main Quest", status: "active" },
    });
    expect(parentOut.ok).toBe(true);
    if (!parentOut.ok) throw new Error("parent quest creation failed");
    const parentId = (parentOut.data as { _id: string })._id;

    // Create sub-quest
    const subOut = await runCreateQuest(transport, {
      data: { name: "Side Objective", status: "active" },
      parentId,
    });
    expect(subOut.ok).toBe(true);
    expect(subOut.steps).toContain("write");

    const quests = Array.from(mock.quests.values());
    expect(quests.length).toBe(2);
    const subQuest = quests[1] as { parent?: string };
    expect(subQuest.parent).toBe(parentId);
  });

  it("creates a quest with rewards (items to give)", async () => {
    const { mock, transport } = setup();
    const out = await runCreateQuest(transport, {
      data: {
        name: "Rescue the Princess",
        status: "active",
        rewards: {
          items: [
            { name: "Crown of Wisdom", type: "loot", value: 500 },
            { name: "Ring of Protection", type: "wondrous", bonus: 1 },
          ],
          gold: 1000,
          xp: 5000,
        },
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("quest creation failed");
    const quest = (out.data as any);
    expect(quest.rewards.items.length).toBe(2);
    expect(quest.rewards.items[0].name).toBe("Crown of Wisdom");
    expect(quest.rewards.gold).toBe(1000);
  });

  it("creates a hierarchical quest structure (main + sub-quests with rewards)", async () => {
    const { mock, transport } = setup();

    // Create main quest with rewards
    const mainOut = await runCreateQuest(transport, {
      data: {
        name: "Complete the Dungeon",
        status: "active",
        rewards: { xp: 10000, gold: 2000 },
      },
    });
    expect(mainOut.ok).toBe(true);
    if (!mainOut.ok) throw new Error("main quest creation failed");
    const mainId = (mainOut.data as { _id: string })._id;

    // Create first sub-quest
    const sub1Out = await runCreateQuest(transport, {
      data: {
        name: "Defeat the Minions",
        status: "active",
        rewards: { xp: 3000, gold: 500 },
      },
      parentId: mainId,
    });
    expect(sub1Out.ok).toBe(true);
    if (!sub1Out.ok) throw new Error("sub1 quest creation failed");
    const sub1Id = (sub1Out.data as { _id: string })._id;

    // Create second sub-quest
    const sub2Out = await runCreateQuest(transport, {
      data: {
        name: "Retrieve the Artifact",
        status: "active",
        rewards: {
          items: [{ name: "Ancient Artifact", type: "relic" }],
          xp: 4000,
          gold: 1000,
        },
      },
      parentId: mainId,
    });
    expect(sub2Out.ok).toBe(true);
    if (!sub2Out.ok) throw new Error("sub2 quest creation failed");

    // Verify structure
    const quests = Array.from(mock.quests.values());
    expect(quests.length).toBe(3);

    const main = quests.find((q: any) => q._id === mainId) as any;
    expect(main.name).toBe("Complete the Dungeon");
    expect(main.rewards.xp).toBe(10000);

    const sub1 = quests.find((q: any) => q._id === sub1Id) as any;
    expect(sub1.parent).toBe(mainId);
    expect(sub1.rewards.gold).toBe(500);

    const sub2 = quests.find((q: any) => q._id !== sub1Id && q.parent === mainId) as any;
    expect(sub2.name).toBe("Retrieve the Artifact");
    expect(sub2.rewards.items?.[0]?.name).toBe("Ancient Artifact");
  });

  it("updates a quest's rewards and status", async () => {
    const { mock, transport } = setup();
    const createOut = await runCreateQuest(transport, {
      data: { name: "Fetch Quest", status: "inactive", rewards: { xp: 100 } },
    });
    expect(createOut.ok).toBe(true);
    if (!createOut.ok) throw new Error("quest creation failed");
    const questId = (createOut.data as { _id: string })._id;

    const updateOut = await runUpdateQuest(transport, {
      id: questId,
      data: { status: "completed", rewards: { xp: 500, gold: 250 } },
    });
    expect(updateOut.ok).toBe(true);

    const quest = mock.quests.get(questId) as any;
    expect(quest.status).toBe("completed");
    expect(quest.rewards.xp).toBe(500);
    expect(quest.rewards.gold).toBe(250);
  });

  it("deletes a quest", async () => {
    const { mock, transport } = setup();
    const createOut = await runCreateQuest(transport, {
      data: { name: "Temporary Quest", status: "inactive" },
    });
    expect(createOut.ok).toBe(true);
    if (!createOut.ok) throw new Error("quest creation failed");
    const questId = (createOut.data as { _id: string })._id;

    const deleteOut = await runDeleteQuest(transport, { id: questId });
    expect(deleteOut.ok).toBe(true);
    expect(mock.quests.has(questId)).toBe(false);
  });

  it("returns NOT_FOUND when updating a non-existent quest", async () => {
    const { transport } = setup();
    const out = await runUpdateQuest(transport, {
      id: "ghost-quest",
      data: { status: "completed" },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("NOT_FOUND");
  });
});
