/**
 * Floorplan spec: rooms, openings and lights on a square grid. Pure: no I/O, browser-safe.
 * Coordinates are whole grid cells; (0,0) is the top-left cell of the picture.
 */

import { z } from "zod";

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
  animation: z.enum(DOOR_ANIMATIONS).optional(),
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

export const FloorplanSchema = z.object({
  name: z.string().min(1),
  style: z.string().min(1).default("fantasy house"),
  cols: z.number().int().min(4).max(60),
  rows: z.number().int().min(4).max(60),
  feetPerCell: z.number().positive().default(5),
  pxPerCell: z.number().int().min(50).max(200).default(100),
  rooms: z.array(RoomSchema).min(1).max(12),
  openings: z.array(OpeningSchema).default([]),
  lights: z.array(FloorplanLightSchema).default([]),
  codex: z.boolean().default(true),
  seed: z.string().optional(),
});

export type Room = z.infer<typeof RoomSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type FloorplanLight = z.infer<typeof FloorplanLightSchema>;
export type Floorplan = z.infer<typeof FloorplanSchema>;
export type FloorplanInput = z.input<typeof FloorplanSchema>;

const SIDE_NAME = { n: "north", e: "east", s: "south", w: "west" } as const;

/** Length of the wall an opening sits in. */
export const sideLength = (room: Room, side: Opening["side"]): number => (side === "n" || side === "s" ? room.w : room.h);

/** Human-readable problems with the rooms, openings and lights. Empty means valid. */
export function validateFloorplan(plan: Floorplan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const r of plan.rooms) {
    if (ids.has(r.id)) errors.push(`duplicate room id "${r.id}"`);
    ids.add(r.id);
    if (r.x + r.w > plan.cols || r.y + r.h > plan.rows) errors.push(`room "${r.id}" leaves the ${plan.cols}x${plan.rows} grid`);
  }
  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      const a = plan.rooms[i]!;
      const b = plan.rooms[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) errors.push(`rooms "${a.id}" and "${b.id}" overlap`);
    }
  }
  plan.openings.forEach((o, i) => {
    const room = plan.rooms.find((r) => r.id === o.room);
    if (!room) {
      errors.push(`opening ${i} names unknown room "${o.room}"`);
      return;
    }
    if (o.at + o.width > sideLength(room, o.side)) {
      errors.push(`opening ${i} does not fit the ${SIDE_NAME[o.side]} wall of "${room.id}" (${sideLength(room, o.side)} cells)`);
    }
  });
  plan.lights.forEach((l, i) => {
    if (l.at[0] >= plan.cols || l.at[1] >= plan.rows) errors.push(`light ${i} is outside the ${plan.cols}x${plan.rows} grid`);
  });
  return errors;
}
