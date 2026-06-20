import { describe, it, expect } from "vitest";
import { computePlan } from "./planner.js";
import type { Manifest, RepoEntity, LiveState } from "./types.js";

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
