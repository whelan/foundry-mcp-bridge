import { describe, expect, it, vi } from "vitest";
import { AUTORUN_FLAG, DEFAULT_AUTORUN_MACROS, parseAutorunList, runAutorun } from "./autorun.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function world(opts: { me?: any; activeGM?: any; macros?: Record<string, any> } = {}) {
  const gm = { id: "gm1", isGM: true };
  const me = opts.me ?? gm;
  const macros = opts.macros ?? {};
  return {
    user: me,
    users: { activeGM: "activeGM" in opts ? opts.activeGM : me },
    macros: { getName: (n: string) => macros[n] },
  };
}
const deps = (game: any) => ({ game, warn: vi.fn(), log: vi.fn(), store: {} as Record<string, unknown> });

describe("parseAutorunList", () => {
  it("splits on commas, trims and drops empties", () => {
    expect(parseAutorunList(" Rejseleder , ,Other ")).toEqual(["Rejseleder", "Other"]);
    expect(parseAutorunList("")).toEqual([]);
    expect(parseAutorunList(undefined)).toEqual([]);
  });
  it("defaults to Rejseleder", () => {
    expect(parseAutorunList(DEFAULT_AUTORUN_MACROS)).toEqual(["Rejseleder"]);
  });
});

describe("runAutorun", () => {
  it("runs each macro in order with { autostart: true } and logs its result", async () => {
    const calls: string[] = [];
    const a = { execute: vi.fn(async (s: any) => { calls.push(`a:${s.autostart}`); return "watching"; }) };
    const b = { execute: vi.fn(async () => { calls.push("b"); return undefined; }) };
    const d = deps(world({ macros: { A: a, B: b } }));
    const res = await runAutorun(["A", "B"], d);
    expect(calls).toEqual(["a:true", "b"]);
    expect(res).toEqual([{ name: "A", ok: true, result: "watching" }, { name: "B", ok: true, result: "done" }]);
    expect(d.log).toHaveBeenCalledWith("[bridge] autorun A: watching");
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("does nothing for a player or a GM who is not the active GM", async () => {
    const m = { execute: vi.fn() };
    expect(await runAutorun(["A"], deps(world({ me: { id: "p", isGM: false }, macros: { A: m } })))).toBeNull();
    expect(await runAutorun(["A"], deps(world({ me: { id: "gm2", isGM: true }, activeGM: { id: "gm1" }, macros: { A: m } })))).toBeNull();
    expect(m.execute).not.toHaveBeenCalled();
  });

  it("runs once per browser", async () => {
    const m = { execute: vi.fn(async () => "watching") };
    const d = deps(world({ macros: { A: m } }));
    await runAutorun(["A"], d);
    expect(await runAutorun(["A"], d)).toBeNull();
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(d.store[AUTORUN_FLAG]).toBe(true);
  });

  it("turns a missing, failing or forbidden macro into one warning each and goes on", async () => {
    const boom = { execute: vi.fn(async () => { throw new Error("kaput"); }) };
    const locked = { canExecute: false, execute: vi.fn() };
    const fine = { execute: vi.fn(async () => "ok") };
    const d = deps(world({ macros: { Boom: boom, Locked: locked, Fine: fine } }));
    const res = await runAutorun(["Nope", "Boom", "Locked", "Fine"], d);
    expect(res?.map((r) => r.ok)).toEqual([false, false, false, true]);
    expect(d.warn).toHaveBeenCalledTimes(3);
    expect(d.warn.mock.calls[0]?.[0]).toContain('"Nope"');
    expect(d.log).toHaveBeenCalledWith("[bridge] autorun Boom: threw: kaput");
    expect(locked.execute).not.toHaveBeenCalled();
    expect(fine.execute).toHaveBeenCalledOnce();
  });
});
