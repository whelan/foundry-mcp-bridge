import { describe, it, expect } from "vitest";
import { FloorplanSchema, validateFloorplan, buildGeometry, type FloorplanInput } from "./floorplan.js";

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

const geo = (over?: Partial<FloorplanInput>) => {
  const g = buildGeometry(parse(over));
  if (!g.ok) throw new Error(g.errors.join("; "));
  return g;
};
const plain = (g: ReturnType<typeof geo>) => g.walls.filter((w) => w.kind === "wall");

describe("buildGeometry", () => {
  it("one room: four merged walls plus the door", () => {
    const g = geo({ rooms: [{ id: "a", x: 1, y: 1, w: 4, h: 3 }], openings: [{ room: "a", side: "w", at: 1, kind: "door" }] });
    expect(g.walls.filter((w) => w.kind === "door")).toEqual([
      { x1: 1, y1: 2, x2: 1, y2: 3, kind: "door", doorOptions: { animation: "swing", double: false, flip: undefined, locked: undefined, open: undefined } },
    ]);
    // west wall is split around the door: 1 cell above, 1 cell below; the other three sides are whole.
    expect(plain(g)).toHaveLength(5);
    expect(plain(g)).toContainEqual({ x1: 1, y1: 1, x2: 5, y2: 1, kind: "wall" });
  });

  it("two touching rooms share one wall, not two", () => {
    const g = geo({
      rooms: [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 4, y: 0, w: 4, h: 4 }],
      openings: [{ room: "a", side: "w", at: 0, kind: "door" }],
    });
    const shared = plain(g).filter((w) => w.x1 === 4 && w.x2 === 4);
    expect(shared).toEqual([{ x1: 4, y1: 0, x2: 4, y2: 4, kind: "wall" }]);
  });

  it("rooms with a gap keep full exterior walls on both sides of the gap", () => {
    const g = geo({
      rooms: [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 6, y: 0, w: 4, h: 4 }],
      openings: [{ room: "a", side: "w", at: 0, kind: "door" }],
    });
    expect(plain(g)).toContainEqual({ x1: 4, y1: 0, x2: 4, y2: 4, kind: "wall" });
    expect(plain(g)).toContainEqual({ x1: 6, y1: 0, x2: 6, y2: 4, kind: "wall" });
  });

  it("a door on the shared edge becomes one door segment in the shared wall", () => {
    const g = geo({
      rooms: [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 4, y: 0, w: 4, h: 4 }],
      openings: [{ room: "a", side: "w", at: 0, kind: "door" }, { room: "a", side: "e", at: 2, kind: "door", animation: "slide" }],
    });
    const door = g.walls.find((w) => w.kind === "door" && w.x1 === 4)!;
    expect(door).toMatchObject({ x1: 4, y1: 2, x2: 4, y2: 3, doorOptions: { animation: "slide" } });
  });

  it("a width-2 opening is one segment; a width-2 door defaults to a double door", () => {
    const g = geo({
      rooms: [{ id: "a", x: 0, y: 0, w: 6, h: 4 }],
      openings: [{ room: "a", side: "s", at: 1, width: 2, kind: "door" }, { room: "a", side: "n", at: 1, width: 3, kind: "window" }],
    });
    expect(g.walls.find((w) => w.kind === "door")).toMatchObject({ x1: 1, y1: 4, x2: 3, y2: 4, doorOptions: { double: true } });
    expect(g.walls.find((w) => w.kind === "window")).toEqual({ x1: 1, y1: 0, x2: 4, y2: 0, kind: "window" });
  });

  it("secret doors and locked doors carry their flags", () => {
    const g = geo({
      rooms: [{ id: "a", x: 0, y: 0, w: 6, h: 4 }],
      openings: [{ room: "a", side: "s", at: 0, kind: "secretDoor" }, { room: "a", side: "s", at: 3, kind: "door", locked: true }],
    });
    expect(g.walls.find((w) => w.kind === "secretDoor")).toBeDefined();
    expect(g.walls.find((w) => w.kind === "door")!.doorOptions).toMatchObject({ locked: true });
  });

  it("rejects overlapping openings, including the same shared edge from both rooms", () => {
    const rooms = [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 4, y: 0, w: 4, h: 4 }];
    const r = buildGeometry(parse({ rooms, openings: [{ room: "a", side: "e", at: 1 }, { room: "b", side: "w", at: 1 }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("openings 0 and 1 overlap");
  });

  it("rejects a house with no exterior door", () => {
    const rooms = [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 4, y: 0, w: 4, h: 4 }];
    const r = buildGeometry(parse({ rooms, openings: [{ room: "a", side: "e", at: 1 }, { room: "a", side: "n", at: 1, kind: "window" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("no exterior door");
  });

  it("places lights at the centre of their cell with the preset applied", () => {
    const g = geo({ lights: [{ at: [3, 2], source: "fireplace" }] });
    expect(g.lights).toEqual([
      { col: 3.5, row: 2.5, source: "fireplace", bright: 15, dim: 30, color: "#ff7a2e", animation: { type: "flame", speed: 4, intensity: 5 } },
    ]);
  });

  it("is deterministic: sorted by position", () => {
    const a = geo();
    const b = geo();
    expect(a.walls).toEqual(b.walls);
    const keys = a.walls.map((w) => [w.y1, w.x1]);
    expect(keys).toEqual([...keys].sort((p, q) => p[0]! - q[0]! || p[1]! - q[1]!));
  });
});
