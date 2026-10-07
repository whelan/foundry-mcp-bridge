import { describe, it, expect } from "vitest";
import { expandObject, isSafePath, applyUpdate, filterUnsafePaths, isSubset } from "./objects.js";

describe("expandObject", () => {
  it("expands dot-paths into nested objects", () => {
    expect(expandObject({ "a.b.c": 1, "a.d": 2 })).toEqual({ a: { b: { c: 1 }, d: 2 } });
  });

  it("does not pollute Object.prototype via __proto__ paths", () => {
    const before = ({} as Record<string, unknown>).polluted;
    const out = expandObject({ "__proto__.polluted": "yes" });
    // The dangerous path is dropped, and no global prototype was touched.
    expect(out).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("drops constructor.prototype paths too, keeping safe ones", () => {
    const out = expandObject({ "constructor.prototype.x": 1, "safe.key": 2 });
    expect(out).toEqual({ safe: { key: 2 } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("isSafePath", () => {
  it("flags prototype-chain segments", () => {
    expect(isSafePath("a.b.c")).toBe(true);
    expect(isSafePath("__proto__.x")).toBe(false);
    expect(isSafePath("a.constructor")).toBe(false);
    expect(isSafePath("a.prototype.b")).toBe(false);
  });

  it("rejects empty segments", () => {
    expect(isSafePath("a..b")).toBe(false);
    expect(isSafePath(".x")).toBe(false);
    expect(isSafePath("x.")).toBe(false);
    expect(isSafePath("")).toBe(false);
  });
});

describe("filterUnsafePaths", () => {
  it("keeps safe keys and drops prototype-chain / malformed ones", () => {
    expect(
      filterUnsafePaths({ "system.hp": 5, name: "x", "__proto__.bad": 1, "a..b": 2 }),
    ).toEqual({ "system.hp": 5, name: "x" });
  });
});

describe("isSubset", () => {
  it("passes when every expected leaf is present and equal, ignoring extra actual fields", () => {
    expect(isSubset({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 })).toBe(true);
    expect(isSubset({ a: { x: 1, y: 2 } }, { a: { x: 1 } })).toBe(true);
  });

  it("fails on a differing primitive or missing key", () => {
    expect(isSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(isSubset({ a: 1 }, { b: 1 })).toBe(false);
  });

  it("compares arrays by length and index", () => {
    expect(isSubset({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(isSubset({ a: [1, 2, 3] }, { a: [1, 2] })).toBe(false);
  });

  it("skips expected keys whose value is undefined (never sent over the wire)", () => {
    // Regression: statblockToFoundryActor emits img/prototypeToken as undefined;
    // Foundry populates them with real defaults on create. An undefined expected
    // value must not force the read-back to also be undefined.
    expect(
      isSubset({ img: "systems/dnd5e/icons/svg/actors/npc.svg", name: "X" }, { img: undefined, name: "X" }),
    ).toBe(true);
  });
});

describe("applyUpdate", () => {
  it("merges a dot-path diff without prototype pollution", () => {
    const out = applyUpdate({ name: "x" }, { "system.hp": 5, "__proto__.bad": 1 });
    expect(out).toEqual({ name: "x", system: { hp: 5 } });
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
  });
});

describe("update removals and inverse updates", () => {
  it("applyUpdate honours -= deletions at any depth", async () => {
    const { applyUpdate } = await import("./objects.js");
    expect(applyUpdate({ a: 1, b: { c: 2, d: 3 } }, { "-=a": null, "b.-=c": null })).toEqual({ b: { d: 3 } });
    expect(applyUpdate({ b: { c: 2 } }, { b: { "-=c": null, e: 1 } })).toEqual({ b: { e: 1 } });
  });

  it("splitRemovals separates sets from deletions", async () => {
    const { splitRemovals } = await import("./objects.js");
    expect(splitRemovals({ "a.b": 1, "x.-=y": null, "-=z": null })).toEqual({ set: { a: { b: 1 } }, removed: ["x.y", "z"] });
  });

  it("buildInverseUpdate restores present values (null included) and deletes absent ones", async () => {
    const { buildInverseUpdate, applyUpdate } = await import("./objects.js");
    const before = { name: "Bob", flags: { n: null, keep: 1 }, tags: ["a"] };
    const diff = { name: "Bobby", "flags.n": 5, "flags.new": 1, "extra.deep.field": 2, tags: ["b"] };
    const inverse = buildInverseUpdate(before, diff);
    expect(inverse).toEqual({ name: "Bob", "flags.n": null, "flags.-=new": null, "-=extra": null, tags: ["a"] });
    expect(applyUpdate(applyUpdate(before, diff), inverse)).toEqual(before);
  });

  it("buildInverseUpdate restores fields the diff deleted", async () => {
    const { buildInverseUpdate, applyUpdate } = await import("./objects.js");
    const before = { a: 1, b: { c: 2 } };
    const diff = { "-=a": null, "b.-=c": null };
    expect(applyUpdate(applyUpdate(before, diff), buildInverseUpdate(before, diff))).toEqual(before);
  });
});
