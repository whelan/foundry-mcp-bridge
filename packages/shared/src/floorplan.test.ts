import { describe, it, expect } from "vitest";
import { FloorplanSchema, validateFloorplan, type FloorplanInput } from "./floorplan.js";

const base = (over: Partial<FloorplanInput> = {}): FloorplanInput => ({
  name: "Cottage",
  cols: 16,
  rows: 10,
  rooms: [
    { id: "hall", x: 1, y: 1, w: 8, h: 8 },
    { id: "kitchen", x: 9, y: 1, w: 6, h: 4 },
    { id: "bedroom", x: 9, y: 5, w: 6, h: 4 },
  ],
  openings: [{ room: "hall", side: "w", at: 3, kind: "door" }],
  ...over,
});
const parse = (over?: Partial<FloorplanInput>) => FloorplanSchema.parse(base(over));

describe("FloorplanSchema", () => {
  it("fills defaults", () => {
    const p = parse();
    expect(p).toMatchObject({ feetPerCell: 5, pxPerCell: 100, codex: true, style: "fantasy house", lights: [] });
    expect(p.rooms[0]!.furnishings).toEqual([]);
    expect(p.openings[0]).toMatchObject({ width: 1, kind: "door" });
  });
  it("rejects a house with no rooms", () => {
    expect(() => FloorplanSchema.parse(base({ rooms: [] }))).toThrow();
  });
});

describe("validateFloorplan: rooms and openings", () => {
  it("accepts the sample cottage", () => {
    expect(validateFloorplan(parse())).toEqual([]);
  });
  it("rejects duplicate room ids", () => {
    const p = parse({ rooms: [{ id: "a", x: 0, y: 0, w: 3, h: 3 }, { id: "a", x: 4, y: 0, w: 3, h: 3 }], openings: [{ room: "a", side: "n", at: 0 }] });
    expect(validateFloorplan(p).join("\n")).toContain('duplicate room id "a"');
  });
  it("rejects a room outside the grid", () => {
    const p = parse({ rooms: [{ id: "a", x: 14, y: 0, w: 4, h: 3 }], openings: [{ room: "a", side: "n", at: 0 }] });
    expect(validateFloorplan(p).join("\n")).toContain('room "a" leaves the 16x10 grid');
  });
  it("rejects overlapping rooms but allows touching ones", () => {
    const touching = parse({ rooms: [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 4, y: 0, w: 4, h: 4 }], openings: [{ room: "a", side: "w", at: 1 }] });
    expect(validateFloorplan(touching)).toEqual([]);
    const overlapping = parse({ rooms: [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 3, y: 0, w: 4, h: 4 }], openings: [{ room: "a", side: "w", at: 1 }] });
    expect(validateFloorplan(overlapping).join("\n")).toContain('rooms "a" and "b" overlap');
  });
  it("rejects an opening on an unknown room", () => {
    expect(validateFloorplan(parse({ openings: [{ room: "attic", side: "n", at: 0 }] })).join("\n")).toContain('opening 0 names unknown room "attic"');
  });
  it("rejects an opening that does not fit its wall", () => {
    const p = parse({ openings: [{ room: "hall", side: "n", at: 7, width: 2 }] });
    expect(validateFloorplan(p).join("\n")).toContain('opening 0 does not fit the north wall of "hall" (8 cells)');
  });
  it("rejects a light outside the grid", () => {
    const p = parse({ lights: [{ at: [20, 2], source: "torch" }] });
    expect(validateFloorplan(p).join("\n")).toContain("light 0 is outside the 16x10 grid");
  });
});
