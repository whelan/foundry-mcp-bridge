import { describe, it, expect } from "vitest";
import { FloorplanSchema, validateFloorplan, buildGeometry, resolveConstruction, wallThicknessPx, resolveRoofs, type FloorplanInput } from "./floorplan.js";

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
    expect(g.ok && g.stairs).toEqual([{ from: 0, to: 1, x: 5, y: 1, w: 3, h: 1, dir: "e", style: "plain" }]);
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

describe("surroundings", () => {
  const cottage = (features: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    FloorplanSchema.parse(base({ cols: 20, rows: 14, surroundings: { features: features as never, ...extra } } as never));
  it("defaults the ground and accepts features outside the house", () => {
    const p = cottage([{ kind: "road", x: 0, y: 11, w: 20, h: 2, note: "rutted cart road" }, { kind: "trees", x: 16, y: 0, w: 4, h: 6 }]);
    expect(p.surroundings?.ground).toBe("trampled grass and dirt");
    expect(validateFloorplan(p)).toEqual([]);
  });
  it("is optional", () => {
    expect(parse().surroundings).toBeUndefined();
  });
  it("rejects a feature that leaves the grid", () => {
    expect(validateFloorplan(cottage([{ kind: "water", x: 18, y: 0, w: 5, h: 2 }])).join("\n")).toContain("leaves the 20x14 grid");
  });
  it("rejects a feature on top of the house, naming the room", () => {
    expect(validateFloorplan(cottage([{ kind: "garden", x: 5, y: 3, w: 2, h: 2 }])).join("\n")).toContain('overlaps the house (room "hall")');
  });
  it("allows touching the house and overlapping other features", () => {
    expect(validateFloorplan(cottage([{ kind: "yard", x: 0, y: 0, w: 20, h: 1 }, { kind: "path", x: 3, y: 0, w: 1, h: 1 }]))).toEqual([]);
  });
  it("a custom feature needs a note", () => {
    expect(validateFloorplan(cottage([{ kind: "custom", x: 0, y: 12, w: 2, h: 2 }])).join("\n")).toContain("needs a note");
    expect(validateFloorplan(cottage([{ kind: "custom", x: 0, y: 12, w: 2, h: 2, note: "a toppled stone idol" }]))).toEqual([]);
  });
  it("rejects an unknown kind", () => {
    expect(() => cottage([{ kind: "lava", x: 0, y: 12, w: 2, h: 2 }])).toThrow();
  });
});

describe("construction", () => {
  const house = (construction?: Record<string, unknown>) =>
    FloorplanSchema.parse(base({ ...(construction ? { construction } : {}), openings: [{ room: "hall", side: "w", at: 3, kind: "door" }, { room: "hall", side: "s", at: 2, kind: "door", style: "stone" }] } as never));
  it("defaults: outer walls thicker than the walls between rooms", () => {
    const c = resolveConstruction(house());
    expect(c.exterior.thickness).toBe(0.6);
    expect(c.interior.thickness).toBe(0.3);
    expect(c.interior.thickness).toBeLessThan(c.exterior.thickness);
  });
  it("takes thickness, material and looks per house", () => {
    const c = resolveConstruction(house({ exterior: { thickness: 2, material: "fieldstone" }, interior: { thickness: 0.5 }, doors: { style: "metal" }, windows: { look: "arrow slits" } }));
    expect(c).toMatchObject({ exterior: { thickness: 2, material: "fieldstone" }, interior: { thickness: 0.5 }, doors: { style: "metal" }, windows: { look: "arrow slits" } });
  });
  it("rejects a silly thickness", () => {
    expect(() => house({ interior: { thickness: 0 } })).toThrow();
    expect(() => house({ exterior: { thickness: 9 } })).toThrow();
  });
  it("wallThicknessPx scales with the grid and never drops under 3", () => {
    expect(wallThicknessPx({ pxPerCell: 100, feetPerCell: 5 }, 0.6)).toBe(12);
    expect(wallThicknessPx({ pxPerCell: 50, feetPerCell: 5 }, 0.1)).toBe(3);
  });
  it("a house-wide door style fills in doors that name none and leaves the others alone", () => {
    const g = buildGeometry(house({ doors: { style: "metal", tone: "rusty" } }));
    if (!g.ok) throw new Error(g.errors.join());
    const doors = g.walls.filter((w) => w.kind === "door");
    const west = doors.find((d) => d.x1 === 1)!;
    const south = doors.find((d) => d.y1 === 9)!;
    expect(west.doorOptions).toMatchObject({ style: "metal", tone: "rusty" });
    expect(south.doorOptions).toMatchObject({ style: "stone" });
    expect(south.doorOptions?.tone).toBeUndefined();
  });
});

describe("stair styles", () => {
  it("defaults to plain and carries style and look onto the placed stair", () => {
    const g = buildGeometry(two({ stairs: [{ at: [2, 1], dir: "s", length: 3, width: 2, style: "grand", look: "black marble" }] }));
    expect(g.ok && g.stairs[0]).toMatchObject({ style: "grand", look: "black marble" });
  });
  it("a grand stair needs width 2, a ladder width 1, a spiral a square footprint", () => {
    const err = (st: Record<string, unknown>) => { const o = buildGeometry(two({ stairs: [st as never] })); return o.ok ? "" : o.errors.join(" "); };
    expect(err({ at: [2, 1], dir: "s", length: 3, width: 1, style: "grand" })).toMatch(/grand stair needs width 2/);
    expect(err({ at: [2, 1], dir: "s", length: 3, width: 2, style: "ladder" })).toMatch(/ladder has width 1/);
    expect(err({ at: [2, 1], dir: "s", length: 3, width: 2, style: "spiral" })).toMatch(/spiral stair needs a square/);
    expect(err({ at: [2, 1], dir: "s", length: 2, width: 2, style: "spiral" })).toBe("");
    expect(err({ at: [2, 1], dir: "s", length: 3, width: 1, style: "ladder" })).toBe("");
  });
  it("rejects an unknown style", () => {
    expect(() => two({ stairs: [{ at: [2, 1], dir: "s", style: "escalator" } as never] })).toThrow();
  });
});

describe("roofs per wing", () => {
  const manor = (over: Record<string, unknown> = {}) => FloorplanSchema.parse({
    name: "Manor", cols: 24, rows: 12, roofStyle: "thatched roof",
    floors: [
      { name: "G", rooms: [{ id: "hall", x: 1, y: 1, w: 10, h: 8 }, { id: "kitchen", x: 11, y: 4, w: 5, h: 5 }, { id: "tower", x: 16, y: 1, w: 4, h: 4 }],
        openings: [{ room: "hall", side: "s", at: 3, kind: "door" }], lights: [{ at: [3, 3], source: "fireplace" }, { at: [13, 6], source: "fireplace" }] },
      { name: "U", rooms: [{ id: "loft", x: 1, y: 1, w: 10, h: 8 }, { id: "tower", x: 16, y: 1, w: 4, h: 4 }] },
    ],
    stairs: [{ at: [3, 5], dir: "e", length: 3 }, { at: [17, 2], dir: "e", length: 2, width: 2, style: "spiral" }],
    roofs: [{ name: "house", rooms: ["hall", "loft"], style: "slate roof", shape: "gabled" }, { name: "tower", rooms: ["tower"], shape: "conical", eave: 4, chimneys: false }],
    ...over,
  });
  it("one default roof over every room when no wing is given, as before", () => {
    const p = manor({ roofs: [] });
    const r = resolveRoofs(p);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "main", explicit: false, top: 1, style: "thatched roof", eaveCells: 0.4 });
    expect(r[0]!.rects).toHaveLength(3); // hall (and the loft above it), kitchen, tower: stacked rooms share one rectangle
  });
  it("wings get their own roof, the unclaimed rooms keep the default one", () => {
    const r = resolveRoofs(manor());
    expect(r.map((x) => x.name)).toEqual(["main", "house", "tower"]);
    expect(r[0]).toMatchObject({ explicit: false, top: 0, style: "thatched roof" });
    expect(r[0]!.rects).toEqual([{ x: 11, y: 4, w: 5, h: 5 }]); // only the kitchen is left
    expect(r[1]).toMatchObject({ explicit: true, top: 1, style: "slate roof", shape: "gabled" });
    expect(r[2]).toMatchObject({ top: 1, shape: "conical", eaveCells: 0.8, chimneys: [] });
  });
  it("puts a chimney over each fireplace under its own roof only", () => {
    const r = resolveRoofs(manor());
    expect(r[0]!.chimneys).toEqual([{ col: 13, row: 6 }]);
    expect(r[1]!.chimneys).toEqual([{ col: 3, row: 3 }]);
  });
  it("roof false means no roofs at all, and giving roofs then is an error", () => {
    expect(resolveRoofs(manor({ roof: false }))).toEqual([]);
    expect(validateFloorplan(manor({ roof: false })).join("\n")).toContain("roofs are given but roof is false");
  });
  it("is valid, and rejects unknown rooms, rooms in two roofs and duplicate names", () => {
    expect(validateFloorplan(manor())).toEqual([]);
    expect(validateFloorplan(manor({ roofs: [{ name: "x", rooms: ["nope"] }] })).join("\n")).toContain('names unknown room "nope"');
    expect(validateFloorplan(manor({ roofs: [{ name: "a", rooms: ["hall"] }, { name: "b", rooms: ["hall"] }] })).join("\n")).toContain('room "hall" is in two roofs');
    expect(validateFloorplan(manor({ roofs: [{ name: "a", rooms: ["hall"] }, { name: "a", rooms: ["kitchen"] }] })).join("\n")).toContain('two roofs are named "a"');
  });
  it("a roof covers the whole stack: stacked rooms cannot be under different roofs", () => {
    const errs = validateFloorplan(manor({ roofs: [{ name: "ground only", rooms: ["hall"] }] })).join("\n");
    expect(errs).toMatch(/"hall" and "loft" are stacked but under different roofs/);
  });
  it("rejects a silly shape or eave", () => {
    expect(() => manor({ roofs: [{ name: "a", rooms: ["hall", "loft"], shape: "pyramid" }] })).toThrow();
    expect(() => manor({ roofs: [{ name: "a", rooms: ["hall", "loft"], eave: 20 }] })).toThrow();
  });
});

describe("cellars", () => {
  const house = (over: Record<string, unknown> = {}) => FloorplanSchema.parse({
    name: "Inn", cols: 24, rows: 14,
    floors: [
      { name: "Ground", rooms: [{ id: "bar", x: 4, y: 3, w: 10, h: 7 }], openings: [{ room: "bar", side: "s", at: 2, kind: "door" }], lights: [{ at: [5, 4], source: "fireplace" }] },
      { name: "Upstairs", rooms: [{ id: "bed", x: 4, y: 3, w: 10, h: 7 }] },
    ],
    // the cellar runs far beyond the house, over the whole picture
    cellars: [
      { name: "Cellar", rooms: [{ id: "store", x: 1, y: 1, w: 12, h: 8 }, { id: "tunnel", x: 13, y: 4, w: 10, h: 2 }], openings: [{ room: "store", side: "e", at: 3, kind: "door" }] },
      { name: "Crypt", rooms: [{ id: "crypt", x: 2, y: 2, w: 6, h: 5 }] },
    ],
    stairs: [{ at: [6, 4], dir: "e", length: 3 }, { at: [5, 3], dir: "e", length: 3, from: -1 }, { at: [3, 3], dir: "s", length: 3, from: -2 }],
    ...over,
  });
  it("lists floors bottom to top with the deepest cellar first and marks the ground floor", () => {
    const p = house();
    expect(p.floors.map((f) => f.name)).toEqual(["Crypt", "Cellar", "Ground", "Upstairs"]);
    expect(p.groundFloor).toBe(2);
    expect("cellars" in p).toBe(false);
  });
  it("shifts the stairs: from 0 is still ground to upstairs, -1 cellar to ground, -2 crypt to cellar", () => {
    const g = buildGeometry(house());
    if (!g.ok) throw new Error(g.errors.join());
    expect(g.stairs.map((s) => [s.from, s.to])).toEqual([[2, 3], [1, 2], [0, 1]]);
  });
  it("without cellars nothing changes: ground floor is index 0 and stairs keep their numbers", () => {
    const p = FloorplanSchema.parse({ ...base(), floors: undefined, rooms: base().rooms });
    expect(p.groundFloor).toBe(0);
    expect(p.floors).toHaveLength(1);
  });
  it("a cellar may use the whole picture and run beyond the house: no overhang rule below ground", () => {
    expect(validateFloorplan(house())).toEqual([]);
  });
  it("the exterior-door rule is for the ground floor, not the cellar", () => {
    expect(buildGeometry(house()).ok).toBe(true);
    const noDoor = buildGeometry(house({ floors: [{ name: "Ground", rooms: [{ id: "bar", x: 4, y: 3, w: 10, h: 7 }] }, { name: "Upstairs", rooms: [{ id: "bed", x: 4, y: 3, w: 10, h: 7 }] }] }));
    expect(noDoor.ok).toBe(false);
    if (!noDoor.ok) expect(noDoor.errors.join()).toMatch(/Ground.*no exterior door|no exterior door/);
  });
  it("floors above the ground floor still cannot overhang", () => {
    const out = validateFloorplan(house({ floors: [{ name: "Ground", rooms: [{ id: "bar", x: 4, y: 3, w: 10, h: 7 }], openings: [{ room: "bar", side: "s", at: 2, kind: "door" }] }, { name: "Upstairs", rooms: [{ id: "bed", x: 4, y: 3, w: 12, h: 7 }] }] }));
    expect(out.join("\n")).toMatch(/Upstairs.*overhang/);
  });
  it("every cellar needs a stair that leaves it upward", () => {
    const out = buildGeometry(house({ stairs: [{ at: [6, 4], dir: "e", length: 3 }, { at: [5, 3], dir: "e", length: 3, from: -1 }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join()).toMatch(/floor "Crypt" is unreachable/);
  });
  it("a stair must lie inside one room on both floors it joins (cellar and ground)", () => {
    const out = buildGeometry(house({ stairs: [{ at: [6, 4], dir: "e", length: 3 }, { at: [2, 1], dir: "e", length: 3, from: -1 }, { at: [3, 3], dir: "s", length: 3, from: -2 }] }));
    expect(out.ok).toBe(false);
  });
  it("rejects more than two cellars and a stair from below the deepest cellar", () => {
    expect(() => house({ cellars: [{ name: "a", rooms: [{ id: "a", x: 1, y: 1, w: 3, h: 3 }] }, { name: "b", rooms: [{ id: "b", x: 1, y: 1, w: 3, h: 3 }] }, { name: "c", rooms: [{ id: "c", x: 1, y: 1, w: 3, h: 3 }] }] })).toThrow();
    expect(() => house({ stairs: [{ at: [3, 3], dir: "s", length: 3, from: -3 }] })).toThrow();
    const o = buildGeometry(house({ cellars: [{ name: "Cellar", rooms: [{ id: "store", x: 1, y: 1, w: 12, h: 8 }] }], stairs: [{ at: [6, 4], dir: "e", length: 3 }, { at: [5, 3], dir: "e", length: 3, from: -2 }] }));
    expect(o.ok).toBe(false);
  });
  it("roofs cover the floors from the ground up only: never a cellar, and a cellar room cannot be named", () => {
    const p = house();
    const r = resolveRoofs(p);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ top: 3 });
    expect(r[0]!.rects).toEqual([{ x: 4, y: 3, w: 10, h: 7 }]);
    expect(r[0]!.chimneys).toEqual([{ col: 5, row: 4 }]);
    const bad = validateFloorplan(house({ roofs: [{ name: "x", rooms: ["store"] }] })).join("\n");
    expect(bad).toContain('names room "store", which is in a cellar');
  });
  it("surroundings are checked against the ground floor, not the cellar", () => {
    const p = house({ surroundings: { features: [{ kind: "road", x: 1, y: 12, w: 22, h: 2 }, { kind: "trees", x: 1, y: 1, w: 2, h: 2 }] } });
    expect(validateFloorplan(p)).toEqual([]); // the cellar store covers x1..13,y1..9 underground, but features are surface
    const bad = validateFloorplan(house({ surroundings: { features: [{ kind: "well", x: 5, y: 4, w: 1, h: 1 }] } })).join("\n");
    expect(bad).toContain('overlaps the house (room "bar")');
  });
  it("the top-level walls and lights are those of the ground floor", () => {
    const g = buildGeometry(house());
    if (!g.ok) throw new Error(g.errors.join());
    expect(g.walls).toBe(g.floors[2]!.walls);
    expect(g.lights).toBe(g.floors[2]!.lights);
  });
});
