import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStatblock, statblockToFoundryActor } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(filename: string) {
  const filePath = path.join(__dirname, "..", "..", "..", "test", "fixtures", "statblock-import", filename);
  return parseStatblock(fs.readFileSync(filePath, "utf-8"));
}

describe("statblockToFoundryActor", () => {
  it("stamps statblockKey flag on the actor", () => {
    const statblock = loadFixture("test-archmage.md");
    const actor = statblockToFoundryActor(statblock);

    expect(actor.flags).toBeDefined();
    expect(actor.flags?.["foundry-mcp-bridge"]?.statblockKey).toBe("test-archmage");
  });

  it("stamps statblockKey flag on each synthesized item (actions and traits)", () => {
    const statblock = loadFixture("test-archmage.md");
    const actor = statblockToFoundryActor(statblock);

    // The test-archmage fixture has a Spellcasting trait and a Dagger action
    const daggerItem = actor.items.find((i) => i.name === "Dagger");
    expect(daggerItem).toBeDefined();
    expect(daggerItem?.flags?.["foundry-mcp-bridge"]?.statblockKey).toBe("action/dagger");

    const spellcastingItem = actor.items.find((i) => i.name === "Spellcasting");
    expect(spellcastingItem).toBeDefined();
    expect(spellcastingItem?.flags?.["foundry-mcp-bridge"]?.statblockKey).toBe("feat/spellcasting");
  });

  it("stamps action prefix on weapon items", () => {
    const statblock = loadFixture("young-ash-wyrm.md");
    const actor = statblockToFoundryActor(statblock);

    // All action-based items should have action/ prefix
    const clawsItem = actor.items.find((i) => i.name === "Claws");
    if (clawsItem) {
      expect(clawsItem.flags?.["foundry-mcp-bridge"]?.statblockKey).toMatch(/^action\//);
    }
  });

  it("stamps feat prefix on trait/feature items", () => {
    const statblock = loadFixture("young-ash-wyrm.md");
    const actor = statblockToFoundryActor(statblock);

    // All traits should have feat/ prefix
    const hasTraitFlag = actor.items.some((item) => {
      const key = item.flags?.["foundry-mcp-bridge"]?.statblockKey as string | undefined;
      return item.type === "feat" && key?.startsWith("feat/");
    });
    expect(hasTraitFlag).toBe(true);
  });

  it("handles statblock names with special characters in key generation", () => {
    const statblock = loadFixture("test-archmage.md");
    const actor = statblockToFoundryActor(statblock);

    // Verify the key is properly slugified
    const key = actor.flags?.["foundry-mcp-bridge"]?.statblockKey as string;
    expect(key).toMatch(/^[a-z0-9-]+$/);
    expect(key).not.toMatch(/^-|-$/); // No leading/trailing hyphens
  });
});
