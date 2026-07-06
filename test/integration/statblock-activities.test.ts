import { describe, it, expect } from "vitest";
import {
  foundryId,
  toDamagePart,
  attackActivity,
  saveActivity,
  utilityActivity,
  parseTemplate,
} from "@foundry-mcp-bridge/statblock-sync";

// Activities are keyed by id; unwrap to the single activity. `any` because
// the builders intentionally return untyped dnd5e shapes and this test file
// is type-checked by tsconfig.test.json.
const only = (acts: Record<string, unknown>): any => Object.values(acts)[0];

describe("foundryId", () => {
  it("generates 16-char alphanumeric ids", () => {
    for (let i = 0; i < 20; i++) {
      expect(foundryId()).toMatch(/^[A-Za-z0-9]{16}$/);
    }
  });
});

describe("toDamagePart", () => {
  it("converts a dice formula with bonus into the structured shape", () => {
    expect(toDamagePart({ formula: "1d10 + 3", type: "slashing" })).toEqual({
      number: 1,
      denomination: 10,
      bonus: "3",
      types: ["slashing"],
      custom: { enabled: false, formula: "" },
      scaling: { number: 1 },
    });
  });

  it("omits the bonus string when there is none", () => {
    expect(toDamagePart({ formula: "4d6", type: "poison" }).bonus).toBe("");
  });
});

describe("attackActivity", () => {
  it("builds a flat-bonus attack activity keyed by its id", () => {
    const acts = attackActivity({ id: "test0000000000id", bonus: 5, attackType: "melee" });
    const act = only(acts);
    expect(act._id).toBe("test0000000000id");
    expect(acts["test0000000000id"]).toBe(act);
    expect(act.type).toBe("attack");
    expect(act.attack).toEqual({
      critical: { threshold: null },
      flat: true,
      ability: "none",
      bonus: "5",
      type: { value: "melee", classification: "" },
    });
    expect(act.damage.includeBase).toBe(true);
    expect(act.activation.type).toBe("action");
  });

  it("carries extra damage parts (the 'plus Xd Y necrotic' case)", () => {
    const acts = attackActivity({
      id: "test0000000000id",
      bonus: 5,
      attackType: "melee",
      extraParts: [toDamagePart({ formula: "1d6", type: "necrotic" })],
    });
    expect(only(acts).damage.parts).toEqual([
      {
        number: 1,
        denomination: 6,
        bonus: "",
        types: ["necrotic"],
        custom: { enabled: false, formula: "" },
        scaling: { number: 1 },
      },
    ]);
  });
});

describe("saveActivity", () => {
  it("builds a flat-DC save with half-on-success damage", () => {
    const acts = saveActivity({
      id: "test0000000000id",
      ability: "con",
      dc: 12,
      parts: [toDamagePart({ formula: "4d6", type: "poison" })],
      onSave: "half",
      template: { type: "cone", size: "15" },
      consumesItemUse: true,
    });
    const act = only(acts);
    expect(act.type).toBe("save");
    expect(act.save).toEqual({
      ability: ["con"],
      dc: { calculation: "", formula: "12" },
    });
    expect(act.damage.onSave).toBe("half");
    expect(act.target.template).toMatchObject({ type: "cone", size: "15", units: "ft" });
    expect(act.consumption.targets).toEqual([
      { type: "itemUses", value: "1", target: "", scaling: {} },
    ]);
  });

  it("defaults to no template and no item-use consumption", () => {
    const acts = saveActivity({
      id: "test0000000000id",
      ability: "wis",
      dc: 10,
      parts: [],
      onSave: "none",
    });
    const act = only(acts);
    expect(act.target.template.type).toBe("");
    expect(act.consumption.targets).toEqual([]);
  });
});

describe("utilityActivity", () => {
  it("builds an action-activation utility activity", () => {
    const acts = utilityActivity({ id: "test0000000000id", activation: "action" });
    expect(only(acts).type).toBe("utility");
    expect(only(acts).activation.type).toBe("action");
  });

  it("supports reaction activation", () => {
    const acts = utilityActivity({ id: "test0000000000id", activation: "reaction" });
    expect(only(acts).activation.type).toBe("reaction");
  });
});

describe("parseTemplate", () => {
  it("finds an area template in a description", () => {
    expect(
      parseTemplate("Constitution Saving Throw: DC 12, each creature in a 15-foot cone."),
    ).toEqual({ type: "cone", size: "15" });
  });

  it("returns undefined when there is no template", () => {
    expect(parseTemplate("Melee Attack Roll: +5, reach 5 ft.")).toBeUndefined();
  });
});
