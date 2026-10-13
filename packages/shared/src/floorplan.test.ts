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
    expect(p).toMatchObject({ feetPerCell: 5, pxPerCell: 100, codex: true, style: "fantasy house", stairs: [], roof: true });
    expect(p.floors[0]!.lights).toEqual([]);
    expect(p.floors[0]!.rooms[0]!.furnishings).toEqual([]);
    expect(p.floors[0]!.openings[0]).toMatchObject({ width: 1, kind: "door" });
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
      { x1: 1, y1: 2, x2: 1, y2: 3, kind: "door", doorOptions: { double: false } },
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

  it("passes style, tone and texture through to the door, and leaves the animation to the style", () => {
    const g = geo({
      rooms: [{ id: "a", x: 0, y: 0, w: 4, h: 4 }],
      openings: [
        { room: "a", side: "w", at: 0, kind: "door", style: "stone", tone: "volcanic" },
        { room: "a", side: "s", at: 1, kind: "door", texture: "worlds/w/d.webp" },
      ],
    });
    const doors = g.walls.filter((w) => w.kind === "door");
    expect(doors[0]!.doorOptions).toMatchObject({ style: "stone", tone: "volcanic" });
    expect(doors[0]!.doorOptions!.animation).toBeUndefined();
    expect(doors[1]!.doorOptions).toMatchObject({ texture: "worlds/w/d.webp" });
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

const ground = {
  name: "Ground",
  rooms: [
    { id: "hall", x: 0, y: 0, w: 8, h: 6 },
    { id: "kitchen", x: 8, y: 0, w: 6, h: 6 },
  ],
  openings: [{ room: "hall", side: "s", at: 2, kind: "door" }],
  lights: [{ at: [1, 1], source: "fireplace" }],
};
const upper = {
  name: "Upstairs",
  rooms: [{ id: "bed", x: 0, y: 0, w: 8, h: 6 }],
  openings: [{ room: "bed", side: "n", at: 2, width: 2, kind: "window" }],
  lights: [{ at: [6, 4], source: "candle" }],
};
const two = (over: Record<string, unknown> = {}) =>
  FloorplanSchema.parse({ name: "T", cols: 16, rows: 8, floors: [ground, upper], stairs: [{ at: [5, 1], dir: "e" }], ...over });

describe("floors", () => {
  it("normalises the single-floor input into one floor", () => {
    const p = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, rooms: ground.rooms.slice(0, 1), openings: ground.openings });
    expect(p.floors).toHaveLength(1);
    expect(p.floors[0]!.rooms[0]!.id).toBe("hall");
    expect(p.roof).toBe(true);
    expect(p.roofStyle).toBe("thatched roof");
  });

  it("rejects both floors and top-level rooms, and neither", () => {
    expect(() => FloorplanSchema.parse({ name: "x", cols: 8, rows: 6, rooms: ground.rooms, floors: [ground] })).toThrow(/floors/i);
    expect(() => FloorplanSchema.parse({ name: "x", cols: 8, rows: 6 })).toThrow();
  });

  it("builds walls and lights per floor and keeps floor 0 on walls/lights", () => {
    const g = buildGeometry(two());
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.floors.map((f) => f.name)).toEqual(["Ground", "Upstairs"]);
    expect(g.walls).toEqual(g.floors[0]!.walls);
    expect(g.lights).toEqual(g.floors[0]!.lights);
    expect(g.floors[0]!.lights[0]).toMatchObject({ col: 1.5, row: 1.5, source: "fireplace" });
    expect(g.floors[1]!.lights[0]).toMatchObject({ col: 6.5, row: 4.5, source: "candle" });
    expect(g.floors[1]!.walls.some((w) => w.kind === "window")).toBe(true);
  });

  it("an upper floor needs no exterior door but the ground floor does", () => {
    expect(buildGeometry(two()).ok).toBe(true);
    const out = buildGeometry(two({ floors: [{ ...ground, openings: [] }, upper] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toContain("no exterior door");
  });

  it("rejects an upper room that overhangs the floor below", () => {
    const out = buildGeometry(two({ floors: [ground, { ...upper, rooms: [{ id: "bed", x: 10, y: 0, w: 8, h: 6 }] }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toMatch(/outside the floor below/);
  });

  it("prefixes errors with the floor name only when there are several floors", () => {
    const single = FloorplanSchema.parse({ name: "S", cols: 4, rows: 4, rooms: [{ id: "a", x: 0, y: 0, w: 9, h: 2 }] });
    expect(validateFloorplan(single)[0]).toMatch(/^room "a" leaves/);
    const multi = two({ floors: [ground, { ...upper, rooms: [{ id: "bed", x: 0, y: 0, w: 99, h: 6 }] }] });
    expect(validateFloorplan(multi).some((e) => e.startsWith('floor "Upstairs": '))).toBe(true);
  });
});

describe("stairs", () => {
  it("places a stair footprint (dir e: length runs along x) joining floor 0 and 1", () => {
    const g = buildGeometry(two());
    expect(g.ok && g.stairs).toEqual([{ from: 0, to: 1, x: 5, y: 1, w: 3, h: 1, dir: "e" }]);
  });

  it("dir n/s runs along y", () => {
    const g = buildGeometry(two({ stairs: [{ at: [2, 1], dir: "n", length: 4, width: 2 }] }));
    expect(g.ok && g.stairs[0]).toMatchObject({ x: 2, y: 1, w: 2, h: 4, dir: "n" });
  });

  it("rejects a stair that leaves its room", () => {
    const out = buildGeometry(two({ stairs: [{ at: [6, 1], dir: "e" }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toMatch(/stair 0.*single room/);
  });

  it("rejects a stair that does not exist inside a room on the upper floor", () => {
    const out = buildGeometry(two({ floors: [ground, { ...upper, rooms: [{ id: "bed", x: 0, y: 0, w: 4, h: 6 }] }] }));
    expect(out.ok).toBe(false);
  });

  it("rejects a stair next to a door or window edge", () => {
    const out = buildGeometry(two({ stairs: [{ at: [2, 5], dir: "e", length: 3 }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toMatch(/stair 0.*(door|window)/);
  });

  it("rejects a stair next to a door declared from the neighbouring room", () => {
    // kitchen (8..14) west wall is hall's east wall at x=8; the door is declared on the kitchen's side
    const g2 = { ...ground, openings: [...ground.openings, { room: "kitchen", side: "w", at: 1, kind: "door" }] };
    const out = buildGeometry(two({ floors: [g2, upper], stairs: [{ at: [7, 0], dir: "s", length: 3 }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toMatch(/stair 0.*(door|window)/);
  });

  it("rejects overlapping stairs and a floor nobody can reach", () => {
    expect(buildGeometry(two({ stairs: [{ at: [1, 1], dir: "e" }, { at: [2, 1], dir: "e" }] })).ok).toBe(false);
    const unreachable = buildGeometry(two({ stairs: [] }));
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) expect(unreachable.errors.join(" ")).toContain("unreachable");
  });

  it("rejects a stair whose upper floor does not exist", () => {
    expect(buildGeometry(two({ stairs: [{ at: [1, 1], dir: "e", from: 1 }] })).ok).toBe(false);
  });

  it("exposes the footprint of every room of every floor", () => {
    const g = buildGeometry(two());
    expect(g.ok && g.footprint).toHaveLength(3);
  });
});
