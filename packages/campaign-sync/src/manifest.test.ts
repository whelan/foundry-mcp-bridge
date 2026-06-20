import { describe, it, expect } from "vitest";
import { parseManifest, serializeManifest, emptyManifest } from "./manifest.js";

const sample = {
  version: 1,
  world: { id: "curse-of-strahd", system: "dnd5e", forge: true },
  entities: {
    "generated/npcs/strahd.md": {
      documentType: "Actor",
      foundryId: "OY1GPYw1bt1vyS2Q",
      contentHash: "sha256:abc",
      remoteModifiedTime: 1781963876080,
      lastImportedAt: "2026-06-20T16:00:00Z",
      assets: [],
    },
  },
};

describe("manifest", () => {
  it("round-trips a valid manifest", () => {
    const m = parseManifest(JSON.stringify(sample));
    expect(m.world.id).toBe("curse-of-strahd");
    const again = parseManifest(serializeManifest(m));
    expect(again).toEqual(m);
  });

  it("emptyManifest builds a version-1 manifest for a world", () => {
    const m = emptyManifest({ id: "w", system: "dnd5e", forge: false });
    expect(m.version).toBe(1);
    expect(m.entities).toEqual({});
  });

  it("rejects a malformed manifest", () => {
    expect(() => parseManifest('{"version":2}')).toThrow();
  });
});
