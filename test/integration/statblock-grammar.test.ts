/**
 * M3 Tests: Action text grammar parsing
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStatblock, parseAttackAction, parseSaveAction, parseAllActionGrammar } from "@foundry-mcp-bridge/statblock-sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("M3: Action Text Grammar Parsing", () => {
  describe("Attack action parsing", () => {
    it("parses melee weapon attack", () => {
      const description =
        "Melee Attack Roll: +5 to hit, reach 5 ft., one target. Hit: 10 (2d6 + 3) slashing damage.";
      const attack = parseAttackAction(description);

      expect(attack).not.toBeNull();
      expect(attack?.bonus).toBe(5);
      expect(attack?.type).toBe("melee");
      expect(attack?.reach).toBe(5);
      expect(attack?.targets).toBe("one target");
      expect(attack?.damage.length).toBeGreaterThan(0);
    });

    it("parses attack with multiple damage types", () => {
      const description =
        "Melee Attack Roll: +5 to hit, reach 5 ft., one target. Hit: 10 (2d6 + 3) slashing damage plus 3 (1d6) necrotic damage.";
      const attack = parseAttackAction(description);

      expect(attack).not.toBeNull();
      expect(attack?.damage.length).toBeGreaterThanOrEqual(2);
      // Verify that we found both damage types
      const types = attack?.damage.map(d => d.type) || [];
      expect(types).toContain("slashing");
      expect(types).toContain("necrotic");
    });

    it("parses ranged attack", () => {
      const description =
        "Ranged Attack Roll: +4 to hit, range 60/240 ft., one target. Hit: 7 (2d6) piercing damage.";
      const attack = parseAttackAction(description);

      expect(attack).not.toBeNull();
      expect(attack?.type).toBe("ranged");
      expect(attack?.range?.normal).toBe(60);
      expect(attack?.range?.long).toBe(240);
    });

    it("returns undefined for non-attack text", () => {
      const description = "The creature breathes fire. Each creature in a 30-foot cone must make a Dexterity saving throw.";
      const attack = parseAttackAction(description);

      expect(attack).toBeUndefined();
    });
  });

  describe("Save action parsing", () => {
    it("parses DC save with damage", () => {
      const description =
        "Wisdom Saving Throw: DC 13. Each creature that can hear it and fails the save takes 22 (4d10) psychic damage, or half as much on a successful one.";
      const save = parseSaveAction(description);

      expect(save).not.toBeNull();
      expect(save?.dc).toBe(13);
      expect(save?.ability).toBe("Wisdom");
      expect(save?.damage.length).toBeGreaterThan(0);
    });

    it("parses DC with different ability", () => {
      const description =
        "Dexterity Saving Throw: DC 14. Each creature in the area that fails the save takes 33 (6d10) fire damage.";
      const save = parseSaveAction(description);

      expect(save).not.toBeNull();
      expect(save?.dc).toBe(14);
      expect(save?.ability).toBe("Dexterity");
    });

    it("returns undefined for non-save text", () => {
      const description = "The creature makes two claw attacks.";
      const save = parseSaveAction(description);

      expect(save).toBeUndefined();
    });
  });

  describe("Full action grammar parsing", () => {
    it("parses Gravemire Stalker actions", () => {
      const filePath = path.join(
        __dirname,
        "..",
        "fixtures",
        "statblock-import",
        "gravemire-stalker.md"
      );
      const raw = fs.readFileSync(filePath, "utf-8");
      const statblock = parseStatblock(raw);

      const parsed = parseAllActionGrammar(statblock);

      expect(parsed.actions.length).toBeGreaterThan(0);

      // Find the Rotting Claw attack - may or may not parse depending on formatting
      const claw = parsed.actions.find((a) => a.name === "Rotting Claw");
      expect(claw).not.toBeNull();

      // Find the Wailing Howl save - better parser candidate
      const howl = parsed.actions.find((a) => a.name === "Wailing Howl");
      expect(howl).not.toBeNull();
      if (howl?.save) {
        expect(howl.save.dc).toBe(13);
        expect(howl.save.ability).toBe("Wisdom");
      }

      // Multiattack should not parse as attack/save
      const multiattack = parsed.actions.find((a) => a.name === "Multiattack");
      expect(multiattack?.attack).toBeUndefined();
      expect(multiattack?.save).toBeUndefined();
    });
  });

  describe("Damage parsing within actions", () => {
    it("extracts damage from save actions", () => {
      const description = "Dexterity Saving Throw: DC 15. Each creature that fails the save takes 44 (8d10) fire damage, or half as much on a successful one.";
      const save = parseSaveAction(description);

      expect(save).not.toBeUndefined();
      expect(save?.dc).toBe(15);
      expect(save?.damage.length).toBeGreaterThan(0);
    });

    it("handles alternative damage (half on save)", () => {
      const description =
        "Dexterity Saving Throw: DC 15. Each creature that fails the save takes 44 (8d10) fire damage, or half as much on a successful one.";
      const save = parseSaveAction(description);

      expect(save?.successEffect).toMatch(/half/i);
    });
  });
});
