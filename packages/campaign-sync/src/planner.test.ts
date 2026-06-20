import { describe, it, expect } from "vitest";
import { computePlan } from "./planner.js";
import type { Manifest, RepoEntity, LiveState, QuestState } from "./types.js";
import { questProgressHash } from "./fql.js";

const world = { id: "w", system: "dnd5e", forge: true };

function manifest(entities: Manifest["entities"] = {}): Manifest {
  return { version: 1, world, entities };
}
function live(docs: LiveState["docs"] = {}): LiveState {
  return { world: { id: "w" }, docs };
}
const actor = (source: string, hash: string): RepoEntity => ({
  source,
  documentType: "Actor",
  contentHash: hash,
  assets: [],
});

describe("planner — documents", () => {
  it("create when no manifest entry", () => {
    const plan = computePlan(manifest(), [actor("npcs/a.md", "sha256:1")], live());
    expect(plan.items[0]?.action).toBe("create");
  });

  it("unchanged when both hashes/mtime match", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:1")], live({ F1: { foundryId: "F1", modifiedTime: 100 } }));
    expect(plan.items[0]?.action).toBe("unchanged");
  });

  it("update when only repo changed", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:2")], live({ F1: { foundryId: "F1", modifiedTime: 100 } }));
    expect(plan.items[0]?.action).toBe("update");
  });

  it("remote-ahead when only Foundry changed", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:1")], live({ F1: { foundryId: "F1", modifiedTime: 200 } }));
    expect(plan.items[0]?.action).toBe("remote-ahead");
  });

  it("conflict when both changed (Foundry wins → skip)", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:2")], live({ F1: { foundryId: "F1", modifiedTime: 200 } }));
    expect(plan.items[0]?.action).toBe("conflict");
  });

  it("missing-remote when manifest id is gone in Foundry", () => {
    const m = manifest({
      "npcs/a.md": { documentType: "Actor", foundryId: "F1", contentHash: "sha256:1", remoteModifiedTime: 100, lastImportedAt: "t", assets: [] },
    });
    const plan = computePlan(m, [actor("npcs/a.md", "sha256:1")], live({}));
    expect(plan.items[0]?.action).toBe("missing-remote");
  });

  it("blocks on world mismatch", () => {
    const plan = computePlan(manifest(), [actor("npcs/a.md", "sha256:1")], { world: { id: "other" }, docs: {} });
    expect(plan.blocked).toBe(true);
    expect(plan.world.matches).toBe(false);
    expect(plan.items).toHaveLength(0);
  });
});

const quest = (source: string, hash: string): RepoEntity => ({
  source,
  documentType: "Quest",
  contentHash: hash,
  assets: [],
});
const qstate = (status: string): QuestState => ({ status, tasks: [], dateStart: null, dateEnd: null });

describe("planner — quests", () => {
  it("quest-pull-progress when only live progress changed", () => {
    const ph = questProgressHash(qstate("inactive"));
    const m = manifest({
      "quests/q.md": { documentType: "Quest", foundryId: "Q1", contentHash: "sha256:1", remoteModifiedTime: 1, progressHash: ph, lastImportedAt: "t", assets: [] },
    });
    const liveQ = live({ Q1: { foundryId: "Q1", modifiedTime: 2, quest: qstate("active") } });
    const plan = computePlan(m, [quest("quests/q.md", "sha256:1")], liveQ);
    expect(plan.items[0]?.action).toBe("quest-pull-progress");
  });

  it("quest-push-structure when only repo structure changed", () => {
    const ph = questProgressHash(qstate("active"));
    const m = manifest({
      "quests/q.md": { documentType: "Quest", foundryId: "Q1", contentHash: "sha256:1", remoteModifiedTime: 1, progressHash: ph, lastImportedAt: "t", assets: [] },
    });
    const liveQ = live({ Q1: { foundryId: "Q1", modifiedTime: 1, quest: qstate("active") } });
    const plan = computePlan(m, [quest("quests/q.md", "sha256:2")], liveQ);
    expect(plan.items[0]?.action).toBe("quest-push-structure");
  });

  it("quest-push-and-pull when both changed (no conflict)", () => {
    const ph = questProgressHash(qstate("inactive"));
    const m = manifest({
      "quests/q.md": { documentType: "Quest", foundryId: "Q1", contentHash: "sha256:1", remoteModifiedTime: 1, progressHash: ph, lastImportedAt: "t", assets: [] },
    });
    const liveQ = live({ Q1: { foundryId: "Q1", modifiedTime: 2, quest: qstate("completed") } });
    const plan = computePlan(m, [quest("quests/q.md", "sha256:2")], liveQ);
    expect(plan.items[0]?.action).toBe("quest-push-and-pull");
  });
});
