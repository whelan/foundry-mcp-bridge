/**
 * Floorplan spec: rooms, openings and lights on a square grid. Pure: no I/O, browser-safe.
 * Coordinates are whole grid cells; (0,0) is the top-left cell of the picture.
 */

import { z } from "zod";
import { resolveLightInput, type DoorOptions, type LightSource, type WallKind } from "./scene-builders.js";
import { DOOR_STYLES } from "./door-textures.js";
export const LIGHT_SOURCES = ["torch", "fireplace", "candle", "lantern", "daylight"] as const;
export const DOOR_ANIMATIONS = ["swing", "slide", "swivel", "ascend", "descend"] as const;

export const RoomSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  floor: z.string().optional().describe("Floor material for the painter, e.g. wooden planks"),
  furnishings: z.array(z.string().min(1)).default([]),
});

export const OpeningSchema = z.object({
  room: z.string().min(1),
  side: z.enum(["n", "e", "s", "w"]),
  at: z.number().int().min(0).describe("Cells from the left end (n/s walls) or the top end (e/w walls)"),
  width: z.number().int().min(1).default(1),
  kind: z.enum(["door", "window", "secretDoor"]).default("door"),
  animation: z.enum(DOOR_ANIMATIONS).optional().describe("Default follows the style: swing, slide for stone, ascend for a portcullis"),
  style: z.enum(DOOR_STYLES).optional().describe("Look of the door from Foundry's core door images (default wood)"),
  tone: z.string().optional().describe("Narrow the style to a colour, e.g. dark, walnut, light, red, ashen (wood); volcanic, earthy, redrock (stone); rusty, gray (metal)"),
  texture: z.string().optional().describe("Your own door image path; wins over style"),
  double: z.boolean().optional(),
  flip: z.boolean().optional(),
  locked: z.boolean().optional(),
  open: z.boolean().optional(),
});

export const FloorplanLightSchema = z.object({
  at: z.tuple([z.number().min(0), z.number().min(0)]).describe("[col, row] of the cell; the light sits at its centre"),
  source: z.enum(LIGHT_SOURCES),
  bright: z.number().min(0).optional(),
  dim: z.number().min(0).optional(),
  color: z.string().optional(),
  animation: z.string().optional(),
});

export const FloorSchema = z.object({
  name: z.string().min(1),
  rooms: z.array(RoomSchema).min(1).max(12),
  openings: z.array(OpeningSchema).default([]),
  lights: z.array(FloorplanLightSchema).default([]),
});

export const StairSchema = z.object({
  at: z.tuple([z.number().int().min(0), z.number().int().min(0)]).describe("[col, row] of the top-left cell of the stair"),
  dir: z.enum(["n", "e", "s", "w"]).describe("The direction you walk to go UP"),
  length: z.number().int().min(2).default(3).describe("Cells along dir"),
  width: z.number().int().min(1).default(1).describe("Cells across"),
  from: z.number().int().min(0).default(0).describe("Lower floor index; the stair joins from and from + 1"),
});

export const FloorplanBaseSchema = z.object({
  name: z.string().min(1),
  style: z.string().min(1).default("fantasy house"),
  cols: z.number().int().min(4).max(60),
  rows: z.number().int().min(4).max(60),
  feetPerCell: z.number().positive().default(5),
  pxPerCell: z.number().int().min(50).max(200).default(100),
  rooms: z.array(RoomSchema).min(1).max(12).optional().describe("Single-floor shortcut: the rooms of floor 1 (use floors for several)"),
  openings: z.array(OpeningSchema).optional(),
  lights: z.array(FloorplanLightSchema).optional(),
  floors: z.array(FloorSchema).min(1).max(4).optional().describe("Several floors, index 0 is the ground floor"),
  stairs: z.array(StairSchema).default([]),
  roof: z.boolean().default(true),
  roofStyle: z.string().min(1).default("thatched roof"),
  codex: z.boolean().default(true),
  seed: z.string().optional(),
});

export const FloorplanSchema = FloorplanBaseSchema.superRefine((p, ctx) => {
  if (p.floors && (p.rooms || p.openings || p.lights)) {
    ctx.addIssue({ code: "custom", message: "give either floors or the single-floor rooms/openings/lights, not both" });
  }
  if (!p.floors && !p.rooms) ctx.addIssue({ code: "custom", message: "give floors, or rooms for a single floor" });
}).transform(({ rooms, openings, lights, floors, ...rest }) => ({
  ...rest,
  floors: floors ?? [{ name: "Ground floor", rooms: rooms ?? [], openings: openings ?? [], lights: lights ?? [] }],
}));

export type Room = z.infer<typeof RoomSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type FloorplanLight = z.infer<typeof FloorplanLightSchema>;
export type Floor = z.infer<typeof FloorSchema>;
export type Stair = z.infer<typeof StairSchema>;
export type Floorplan = z.output<typeof FloorplanSchema>;
export type FloorplanInput = z.input<typeof FloorplanBaseSchema>;

const SIDE_NAME = { n: "north", e: "east", s: "south", w: "west" } as const;

/** Length of the wall an opening sits in. */
export const sideLength = (room: Room, side: Opening["side"]): number => (side === "n" || side === "s" ? room.w : room.h);

const cellKey = (x: number, y: number) => `${x},${y}`;
const cellsOfRect = (x: number, y: number, w: number, h: number): string[] => {
  const out: string[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push(cellKey(x + i, y + j));
  return out;
};

/** A stair footprint in cells: `x,y` is its top-left cell, it joins floor `from` to floor `to`. */
export interface PlacedStair {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dir: Stair["dir"];
}

export function placeStair(s: Stair): PlacedStair {
  const horizontal = s.dir === "e" || s.dir === "w";
  return { from: s.from, to: s.from + 1, x: s.at[0], y: s.at[1], w: horizontal ? s.length : s.width, h: horizontal ? s.width : s.length, dir: s.dir };
}

function validateFloor(plan: { cols: number; rows: number }, floor: Floor, prefix: string): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const r of floor.rooms) {
    if (ids.has(r.id)) errors.push(`duplicate room id "${r.id}"`);
    ids.add(r.id);
    if (r.x + r.w > plan.cols || r.y + r.h > plan.rows) errors.push(`room "${r.id}" leaves the ${plan.cols}x${plan.rows} grid`);
  }
  for (let i = 0; i < floor.rooms.length; i++) {
    for (let j = i + 1; j < floor.rooms.length; j++) {
      const a = floor.rooms[i]!;
      const b = floor.rooms[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) errors.push(`rooms "${a.id}" and "${b.id}" overlap`);
    }
  }
  floor.openings.forEach((o, i) => {
    const room = floor.rooms.find((r) => r.id === o.room);
    if (!room) {
      errors.push(`opening ${i} names unknown room "${o.room}"`);
      return;
    }
    if (o.at + o.width > sideLength(room, o.side)) {
      errors.push(`opening ${i} does not fit the ${SIDE_NAME[o.side]} wall of "${room.id}" (${sideLength(room, o.side)} cells)`);
    }
  });
  floor.lights.forEach((l, i) => {
    if (l.at[0] >= plan.cols || l.at[1] >= plan.rows) errors.push(`light ${i} is outside the ${plan.cols}x${plan.rows} grid`);
  });
  return errors.map((e) => prefix + e);
}

/** The room of `floor` that holds every cell of the footprint, if there is one. */
function roomHolding(floor: Floor, st: PlacedStair): Room | undefined {
  return floor.rooms.find((r) => st.x >= r.x && st.y >= r.y && st.x + st.w <= r.x + r.w && st.y + st.h <= r.y + r.h);
}

/** Does an opening edge touch a cell of the stair footprint? */
function edgeTouches(e: Edge, st: PlacedStair): boolean {
  const inside = (cx: number, cy: number) => cx >= st.x && cx < st.x + st.w && cy >= st.y && cy < st.y + st.h;
  return e.orient === "h" ? inside(e.x, e.y - 1) || inside(e.x, e.y) : inside(e.x - 1, e.y) || inside(e.x, e.y);
}

function validateStairs(plan: { floors: Floor[]; stairs: Stair[] }): string[] {
  const errors: string[] = [];
  const placed = plan.stairs.map(placeStair);
  placed.forEach((st, i) => {
    const lower = plan.floors[st.from];
    const upper = plan.floors[st.to];
    if (!lower || !upper) {
      errors.push(`stair ${i} joins floor ${st.from} to a floor that does not exist`);
      return;
    }
    if (!roomHolding(lower, st) || !roomHolding(upper, st)) {
      errors.push(`stair ${i} must lie inside a single room on both floors it joins`);
      return;
    }
    // Any opening of the floor counts, whichever room declares it: a door on a shared wall can be written from the neighbour's side.
    for (const floor of [lower, upper]) {
      for (const o of floor.openings) {
        const owner = floor.rooms.find((r) => r.id === o.room);
        if (owner && openingEdges(owner, o).some((e) => edgeTouches(e, st))) errors.push(`stair ${i} covers or touches a door or window of "${owner.id}"`);
      }
    }
  });
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.from === b.from && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) errors.push(`stairs ${i} and ${j} overlap`);
    }
  }
  for (let k = 1; k < plan.floors.length; k++) {
    if (!placed.some((st) => st.to === k)) errors.push(`floor "${plan.floors[k]!.name}" is unreachable (no stair leads to it)`);
  }
  return errors;
}

/** Human-readable problems with the floors, rooms, openings, lights and stairs. Empty means valid. */
export function validateFloorplan(plan: Floorplan): string[] {
  const errors: string[] = [];
  const multi = plan.floors.length > 1;
  for (const f of plan.floors) errors.push(...validateFloor(plan, f, multi ? `floor "${f.name}": ` : ""));
  // A floor cannot overhang the one below: every cell of an upper room is a cell of a lower room.
  for (let i = 1; i < plan.floors.length; i++) {
    const below = new Set(plan.floors[i - 1]!.rooms.flatMap((r) => cellsOfRect(r.x, r.y, r.w, r.h)));
    for (const r of plan.floors[i]!.rooms) {
      if (cellsOfRect(r.x, r.y, r.w, r.h).some((c) => !below.has(c))) {
        errors.push(`floor "${plan.floors[i]!.name}": room "${r.id}" is outside the floor below (a floor cannot overhang)`);
      }
    }
  }
  errors.push(...validateStairs(plan));
  return errors;
}

export interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: WallKind;
  doorOptions?: DoorOptions;
}

export interface PlacedLight {
  col: number;
  row: number;
  source: LightSource;
  bright: number;
  dim: number;
  color: string | null;
  animation: { type: string | null; speed: number; intensity: number };
}

/** A unit edge on the grid: "h" runs (x,y) to (x+1,y); "v" runs (x,y) to (x,y+1). */
interface Edge {
  orient: "h" | "v";
  x: number;
  y: number;
}
const edgeKey = (e: Edge) => `${e.orient}:${e.x}:${e.y}`;

function roomEdges(r: Room): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < r.w; i++) out.push({ orient: "h", x: r.x + i, y: r.y }, { orient: "h", x: r.x + i, y: r.y + r.h });
  for (let j = 0; j < r.h; j++) out.push({ orient: "v", x: r.x, y: r.y + j }, { orient: "v", x: r.x + r.w, y: r.y + j });
  return out;
}

function openingEdges(r: Room, o: Opening): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < o.width; i++) {
    if (o.side === "n") out.push({ orient: "h", x: r.x + o.at + i, y: r.y });
    else if (o.side === "s") out.push({ orient: "h", x: r.x + o.at + i, y: r.y + r.h });
    else if (o.side === "w") out.push({ orient: "v", x: r.x, y: r.y + o.at + i });
    else out.push({ orient: "v", x: r.x + r.w, y: r.y + o.at + i });
  }
  return out;
}

const KIND_OF: Record<Opening["kind"], WallKind> = { door: "door", secretDoor: "secretDoor", window: "window" };

function floorGeometry(floor: Floor, isGround: boolean): { ok: true; walls: WallSegment[]; lights: PlacedLight[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const rooms = new Map(floor.rooms.map((r) => [r.id, r]));
  const roomsPerEdge = new Map<string, number>();
  const edges = new Map<string, Edge>();
  for (const r of floor.rooms) {
    for (const e of roomEdges(r)) {
      const k = edgeKey(e);
      roomsPerEdge.set(k, (roomsPerEdge.get(k) ?? 0) + 1);
      edges.set(k, e);
    }
  }

  const walls: WallSegment[] = [];
  const claimed = new Map<string, number>();
  let exteriorDoors = 0;
  floor.openings.forEach((o, i) => {
    const es = openingEdges(rooms.get(o.room)!, o);
    for (const e of es) {
      const k = edgeKey(e);
      const prev = claimed.get(k);
      if (prev !== undefined) errors.push(`openings ${prev} and ${i} overlap`);
      else claimed.set(k, i);
    }
    const first = es[0]!;
    const last = es[es.length - 1]!;
    const seg: WallSegment =
      first.orient === "h"
        ? { x1: first.x, y1: first.y, x2: last.x + 1, y2: first.y, kind: KIND_OF[o.kind] }
        : { x1: first.x, y1: first.y, x2: first.x, y2: last.y + 1, kind: KIND_OF[o.kind] };
    if (o.kind !== "window") {
      seg.doorOptions = {
        double: o.double ?? o.width >= 2,
        ...(o.animation && { animation: o.animation }),
        ...(o.style && { style: o.style }),
        ...(o.tone && { tone: o.tone }),
        ...(o.texture && { texture: o.texture }),
        ...(o.flip !== undefined && { flip: o.flip }),
        ...(o.locked !== undefined && { locked: o.locked }),
        ...(o.open !== undefined && { open: o.open }),
      };
      if (es.every((e) => roomsPerEdge.get(edgeKey(e)) === 1)) exteriorDoors++;
    }
    walls.push(seg);
  });
  if (isGround && exteriorDoors === 0) errors.push("the house has no exterior door");
  if (errors.length) return { ok: false, errors };

  // Plain walls: every unclaimed unit edge, merged into runs along its line.
  const lines = new Map<string, { orient: "h" | "v"; line: number; positions: number[] }>();
  for (const [k, e] of edges) {
    if (claimed.has(k)) continue;
    const line = e.orient === "h" ? e.y : e.x;
    const lk = `${e.orient}:${line}`;
    const entry = lines.get(lk) ?? { orient: e.orient, line, positions: [] };
    entry.positions.push(e.orient === "h" ? e.x : e.y);
    lines.set(lk, entry);
  }
  for (const { orient, line, positions } of lines.values()) {
    positions.sort((a, b) => a - b);
    let start = positions[0]!;
    let prev = start;
    const flush = (end: number) =>
      walls.push(orient === "h" ? { x1: start, y1: line, x2: end + 1, y2: line, kind: "wall" } : { x1: line, y1: start, x2: line, y2: end + 1, kind: "wall" });
    for (const p of positions.slice(1)) {
      if (p !== prev + 1) {
        flush(prev);
        start = p;
      }
      prev = p;
    }
    flush(prev);
  }
  walls.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1 || a.y2 - b.y2 || a.x2 - b.x2);

  const lights: PlacedLight[] = floor.lights.map((l) => ({ col: l.at[0] + 0.5, row: l.at[1] + 0.5, source: l.source, ...resolveLightInput(l) }));
  return { ok: true, walls, lights };
}

export interface FloorGeometry {
  name: string;
  walls: WallSegment[];
  lights: PlacedLight[];
}

export function buildGeometry(
  plan: Floorplan,
):
  | { ok: true; walls: WallSegment[]; lights: PlacedLight[]; floors: FloorGeometry[]; stairs: PlacedStair[]; footprint: Array<{ x: number; y: number; w: number; h: number }> }
  | { ok: false; errors: string[] } {
  const errors = validateFloorplan(plan);
  if (errors.length) return { ok: false, errors };
  const floors: FloorGeometry[] = [];
  for (let i = 0; i < plan.floors.length; i++) {
    const f = plan.floors[i]!;
    const g = floorGeometry(f, i === 0);
    if (!g.ok) return { ok: false, errors: plan.floors.length > 1 ? g.errors.map((e) => `floor "${f.name}": ${e}`) : g.errors };
    floors.push({ name: f.name, walls: g.walls, lights: g.lights });
  }
  const footprint = plan.floors.flatMap((f) => f.rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })));
  return { ok: true, walls: floors[0]!.walls, lights: floors[0]!.lights, floors, stairs: plan.stairs.map(placeStair), footprint };
}
