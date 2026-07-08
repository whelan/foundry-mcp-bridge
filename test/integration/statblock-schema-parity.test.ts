import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { parseStatblock, statblockToFoundryActor } from "@foundry-mcp-bridge/statblock-sync";

const load = (f: string) =>
  JSON.parse(fs.readFileSync(`test/fixtures/dnd5e-53-schema/${f}`, "utf-8"));
const ghast = load("ghast-full.json");
const wyrmling = load("white-dragon-wyrmling-full.json");
const rottingTouch = load("rotting-touch-weapon.json");
const abduct = load("abduct-feat.json");

const statblock = parseStatblock(
  fs.readFileSync("test/fixtures/statblock-import/gravemire-stalker.md", "utf-8"),
);
const actor = statblockToFoundryActor(statblock);

/**
 * Compendium documents strip schema-default keys, so no single official shows
 * the full legal shape (Ghast's Claw attack activity has no attack.bonus key;
 * Rotting Touch's does). Union multiple officials into one reference: an
 * emitted key is legal iff SOME official document carries it.
 */
function mergeOfficials(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    return aa.length >= bb.length ? aa : bb;
  }
  if (typeof a !== "object" || typeof b !== "object") return a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    out[k] = k in out ? mergeOfficials(out[k], v) : v;
  }
  return out;
}

/**
 * Assert every key path in `emitted` also exists in `official` (the merged
 * reference). Values may differ; inventing keys dnd5e doesn't have may not.
 * Arrays: elements are compared against the official array's first element
 * when one exists. Reports the offending path on failure.
 */
function expectKeySubset(emitted: unknown, official: unknown, path = "$"): void {
  if (emitted === null || typeof emitted !== "object") return;
  if (Array.isArray(emitted)) {
    const officialFirst = Array.isArray(official) ? official[0] : undefined;
    if (officialFirst === undefined) return;
    for (const el of emitted) expectKeySubset(el, officialFirst, `${path}[]`);
    return;
  }
  expect(official, `${path} exists in the official documents`).toBeTypeOf("object");
  for (const [k, v] of Object.entries(emitted as Record<string, unknown>)) {
    expect(
      Object.prototype.hasOwnProperty.call(official as object, k),
      `${path}.${k} is a real dnd5e 5.3.3 key`,
    ).toBe(true);
    expectKeySubset(v, (official as Record<string, unknown>)[k], `${path}.${k}`);
  }
}

const itemByName = (doc: { items: any[] }, name: string) =>
  doc.items.find((i: any) => i.name === name);
const activityOfType = (item: any, type: string): any =>
  Object.values(item.system.activities as Record<string, any>).find((a) => a.type === type);

describe("emitted shapes are key-subsets of real dnd5e 5.3.3 documents", () => {
  const ghastClaw = itemByName(ghast, "Claw");
  const stench = itemByName(ghast, "Stench");
  const breathOfficial = itemByName(wyrmling, "Cold Breath");
  const multiOfficial = itemByName(wyrmling, "Multiattack");

  const emittedClaw = actor.items.find((i) => i.name === "Claw")! as any;
  const emittedBreath = actor.items.find((i) => i.name === "Grave Breath")! as any;
  const emittedMulti = actor.items.find((i) => i.name === "Multiattack")! as any;
  const emittedTrait = actor.items.find((i) => i.name === "Stench of the Grave")! as any;

  it("attack weapon system and activity", () => {
    const { activities: _e, ...emittedSys } = emittedClaw.system;
    const { activities: _o1, ...clawSys } = ghastClaw.system;
    const { activities: _o2, ...rtSys } = rottingTouch.system;
    expectKeySubset(emittedSys, mergeOfficials(clawSys, rtSys), "claw.system");
    expectKeySubset(
      activityOfType(emittedClaw, "attack"),
      mergeOfficials(activityOfType(ghastClaw, "attack"), activityOfType(rottingTouch, "attack")),
      "claw.attackActivity",
    );
  });

  it("save feat system and activity (vs Cold Breath + Stench)", () => {
    const { activities: _e, ...emittedSys } = emittedBreath.system;
    const { activities: _o1, ...breathSys } = breathOfficial.system;
    const { activities: _o2, ...stenchSys } = stench.system;
    expectKeySubset(emittedSys, mergeOfficials(breathSys, stenchSys), "breath.system");
    expectKeySubset(
      activityOfType(emittedBreath, "save"),
      mergeOfficials(activityOfType(breathOfficial, "save"), activityOfType(stench, "save")),
      "breath.saveActivity",
    );
  });

  it("utility feat (vs Multiattack)", () => {
    const { activities: _e, ...emittedSys } = emittedMulti.system;
    const { activities: _o, ...multiSys } = multiOfficial.system;
    expectKeySubset(emittedSys, multiSys, "multiattack.system");
    expectKeySubset(
      activityOfType(emittedMulti, "utility"),
      activityOfType(multiOfficial, "utility"),
      "multiattack.utilityActivity",
    );
  });

  it("passive trait feat (vs Stench + Abduct)", () => {
    const { activities: _e, ...emittedSys } = emittedTrait.system;
    const { activities: _o1, ...stenchSys } = stench.system;
    const { activities: _o2, ...abductSys } = abduct.system;
    expectKeySubset(emittedSys, mergeOfficials(stenchSys, abductSys), "trait.system");
  });

  it("actor system (vs Ghast + Wyrmling union)", () => {
    expectKeySubset(actor.system, mergeOfficials(ghast.system, wyrmling.system), "actor.system");
  });

  it("item types are real dnd5e types", () => {
    for (const item of actor.items) expect(["weapon", "feat"]).toContain(item.type);
  });
});
