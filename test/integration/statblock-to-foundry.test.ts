/**
 * M4 Tests: Convert to Foundry dnd5e actor JSON
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStatblock, statblockToFoundryActor } from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("M4: Convert to Foundry dnd5e Actor", () => {
  it("creates valid actor document from statblock", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);

    const actor = statblockToFoundryActor(statblock);

    // Verify basic structure
    expect(actor.name).toBe("Gravemire Stalker");
    expect(actor.type).toBe("npc");
    expect(actor.system).toBeDefined();
    expect(actor.items).toBeDefined();
    expect(actor.effects).toBeDefined();
  });

  it("sets correct ability scores", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.abilities.str.value).toBe(16);
    expect(system.abilities.dex.value).toBe(14);
    expect(system.abilities.con.value).toBe(14);
    expect(system.abilities.int.value).toBe(9);
    expect(system.abilities.wis.value).toBe(11);
    expect(system.abilities.cha.value).toBe(8);
  });

  it("sets correct AC and HP", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.attributes.ac.flat).toBe(15);
    expect(system.attributes.hp.value).toBe(52);
    expect(system.attributes.hp.max).toBe(52);
    expect(system.attributes.hp.formula).toBe("8d8 + 16");
  });

  it("sets CR and XP", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.details.cr).toBe(3);
    expect(system.details.xp).toBe(700);
  });

  it("includes traits and resistances", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    const system = actor.system as Record<string, any>;
    expect(system.traits_.damageResistances.value).toContain("necrotic");
    expect(system.traits.senses).toContain("darkvision");
  });

  it("creates items from abilities and actions", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "fixtures",
      "statblock-import",
      "gravemire-stalker.md"
    );
    const raw = fs.readFileSync(filePath, "utf-8");
    const statblock = parseStatblock(raw);
    const actor = statblockToFoundryActor(statblock);

    // Should have items for abilities and actions
    expect(actor.items.length).toBeGreaterThan(0);

    // Look for expected items (names may have periods from parsing)
    const itemNames = actor.items.map((i) => i.name.replace(/\.$/, ""));
    expect(itemNames).toContain("Undead Fortitude");
    expect(itemNames).toContain("Multiattack");
    expect(itemNames).toContain("Rotting Claw");
  });
});
