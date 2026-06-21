import { describe, it, expect } from "vitest";
import { expandObject, isSafePath, applyUpdate, filterUnsafePaths } from "./objects.js";

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

describe("applyUpdate", () => {
  it("merges a dot-path diff without prototype pollution", () => {
    const out = applyUpdate({ name: "x" }, { "system.hp": 5, "__proto__.bad": 1 });
    expect(out).toEqual({ name: "x", system: { hp: 5 } });
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
  });
});
