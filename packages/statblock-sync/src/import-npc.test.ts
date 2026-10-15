import { describe, it, expect } from "vitest";
import {
  buildCompendiumRefreshPatch,
  buildTier1Item,
  buildTier1ItemPatch,
  buildTier1ActorData,
} from "./import-npc.js";
import type { CompendiumDocument } from "@foundry-mcp-bridge/shared";

const fresh: CompendiumDocument & { uuid: string } = {
  uuid: "Compendium.dnd5e.actors24.Actor.arch",
  name: "Archmage",
  img: "icons/archmage.webp",
  system: {
    attributes: {
      ac: { flat: 12, calcs: ["natural"], override: null },
      hp: { value: 40, max: 99, temp: 5, tempmax: 0, formula: "18d8" },
      exhaustion: 2,
    },
    details: { cr: 12 },
    currency: { gp: 50 },
  },
  items: [
    {
      uuid: "Compendium.dnd5e.actors24.Actor.arch.Item.dagger",
      name: "Dagger",
      type: "weapon",
      img: "i.webp",
      system: { damage: 4, uses: { spent: 1 }, equipped: true },
    },
  ],
};

describe("buildCompendiumRefreshPatch", () => {
  it("refreshes compendium-owned fields and strips Foundry-owned runtime leaves", () => {
    const patch = buildCompendiumRefreshPatch(fresh) as any;
    expect(patch.name).toBe("Archmage");
    expect(patch.system.attributes.ac.flat).toBe(12);
    expect(patch.system.attributes.hp.max).toBe(99);
    expect(patch.system.attributes.hp.formula).toBe("18d8");
    // runtime leaves stripped:
    expect(patch.system.attributes.hp.value).toBeUndefined();
    expect(patch.system.attributes.hp.temp).toBeUndefined();
    expect(patch.system.attributes.exhaustion).toBeUndefined();
    expect(patch.system.currency).toBeUndefined();
    expect(patch.img).toBeUndefined(); // only set when supplied
  });

  it("sets img/folder only when supplied", () => {
    const patch = buildCompendiumRefreshPatch(fresh, "worlds/x.webp", "folder1") as any;
    expect(patch.img).toBe("worlds/x.webp");
    expect(patch.folder).toBe("folder1");
  });
});

describe("buildTier1Item", () => {
  it("stamps the item's sourceUuid provenance flag", () => {
    const item = buildTier1Item(fresh.items[0]!) as any;
    expect(item.name).toBe("Dagger");
    expect(item.flags["foundry-mcp-bridge"].sourceUuid).toBe(fresh.items[0]!.uuid);
  });

  it("does not carry the compendium item's own uuid as a stray top-level field", () => {
    // A live Foundry create's read-back verification compares every key we
    // send against the newly-created item's own (different) world uuid --
    // sending the source uuid as a literal `uuid` field spuriously fails
    // that comparison and rolls back an otherwise-valid create.
    const item = buildTier1Item(fresh.items[0]!) as any;
    expect(item.uuid).toBeUndefined();
  });
});

describe("buildTier1ItemPatch", () => {
  it("strips item-level runtime (spent uses, equipped, attunement)", () => {
    const patch = buildTier1ItemPatch(fresh.items[0]!) as any;
    expect(patch.name).toBe("Dagger");
    expect(patch.system.damage).toBe(4);
    // runtime stripped:
    expect(patch.system.uses?.spent).toBeUndefined();
    expect(patch.system.equipped).toBeUndefined();
    expect(patch.system.attunement).toBeUndefined();
  });
});

describe("buildTier1ActorData", () => {
  it("builds an npc actor with tier/compendiumUuid flags and stamped items", () => {
    const data = buildTier1ActorData(fresh, "archmage", fresh.uuid) as any;
    expect(data.type).toBe("npc");
    expect(data.name).toBe("Archmage");
    expect(data.flags["foundry-mcp-bridge"]).toEqual({
      statblockKey: "archmage",
      tier: 1,
      compendiumUuid: fresh.uuid,
    });
    expect(data.items[0].flags["foundry-mcp-bridge"].sourceUuid).toBe(fresh.items[0]!.uuid);
  });
});
