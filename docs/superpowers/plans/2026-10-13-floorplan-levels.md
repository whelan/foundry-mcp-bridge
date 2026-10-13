# Floorplan Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `build_floorplan_scene` builds a house with 1 to 4 floors (Foundry 14 Levels), stairs between floors (`changeLevel` regions) and a roof tile that hides the interior from outside.

**Architecture:** The pure geometry in `packages/shared/src/floorplan.ts` is generalised from one floor to `floors[]` plus `stairs[]`; the schema normalises the old single-floor input into one floor. Drawing (`floorplan-render.ts`) gains stairs and a roof footprint guide. Several images run as one image job (`ImageRequest.parts`). `finishFloorplan` creates the scene, then levels, per-level walls and lights, stair regions and the roof tile through the existing reliable embedded-document pipeline.

**Tech Stack:** TypeScript, zod, vitest, ImageMagick (`magick`), Foundry VTT 14.368 documents (Level, Wall, AmbientLight, Region, Tile).

**Spec:** `docs/superpowers/specs/2026-10-13-floorplan-levels-design.md` (read it first; it holds the Foundry facts verified live).

## Global Constraints

- Foundry 14 only: the tool already refuses a world older than 14. Do not add 13 fallbacks.
- Floor height is 10 scene units. Level f has `elevation {bottom: 10f, top: 10f+10}`. The roof tile elevation is `10 * floors`.
- Floors: 1 to 4. Rooms per floor: 1 to 12. Stair `length` default 3 (min 2), `width` default 1, `from` default 0.
- `roof` defaults to `true`, `roofStyle` defaults to `"thatched roof"`.
- The single-floor input (top-level `rooms`, `openings`, `lights`) keeps working and gives identical walls and lights. Giving both `floors` and top-level `rooms` is a validation error.
- A new Scene always has one level with id `defaultLevel0000`; level 0 reuses it (rename, re-range), never creates a second ground level.
- Every write goes through the existing reliable pipeline (`runCreateEmbedded`, `runUpdateEmbedded`, `runAddWalls`, `runAddLights`) so it is read-back verified, logged and undoable by requestId.
- Pixel positions for regions and the roof tile include the scene's grid origin (padding offset) exactly as `add_walls` does (`gridToPixels(col, row, size, origin)`).
- Code style: match the surrounding files (no new dependencies, short doc comments, no ad-hoc logging).
- Test commands: `npx vitest run <file>`, whole suite `npm test`, plus `npm run typecheck` and `npm run selftest` at the end of each task that touches types.
- Commit message trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A stair that touches a wall, covers a door or window edge, or leaves its room on the upper floor must be rejected with a readable message, not produce a broken scene (Task 1 tests).
- An upper-floor room that overhangs the floor below must be rejected (Task 1 tests).
- Single-floor input must behave exactly as before, including old error messages (Task 1 tests: existing floorplan tests stay green unchanged except the intentional ones listed).
- ImageMagick missing: floors and levels still build, the roof is skipped with a warning, nothing throws (Task 4 test).
- A part failing in the middle of a multi-image job fails the whole job and leaves earlier files on disk (Task 3 test).
- The grid origin (scene padding) is applied to stair regions and the roof tile; a scene with origin (50, 50) must not shift them off the walls (Task 4 test).

---

### Task 1: Floors, stairs and validation in the shared geometry

**Files:**
- Modify: `packages/shared/src/floorplan.ts`
- Modify: `packages/shared/src/floorplan.test.ts`

**Interfaces:**
- Consumes: existing `RoomSchema`, `OpeningSchema`, `FloorplanLightSchema`, `WallSegment`, `PlacedLight`, `resolveLightInput`.
- Produces (exported from `floorplan.ts`, so from `@foundry-mcp-bridge/shared`):
  - `FloorSchema`, `StairSchema`, `FloorplanBaseSchema` (a plain `z.object`, has `.shape`), `FloorplanSchema` (= base + superRefine + transform to the normalised plan), types `Floor`, `Stair`, `Floorplan` (output type: always has `floors: Floor[]`, no top-level rooms/openings/lights), `FloorplanInput`.
  - `PlacedStair { from: number; to: number; x: number; y: number; w: number; h: number; dir: "n"|"e"|"s"|"w" }` (cells; `x,y` top-left cell).
  - `FloorGeometry { name: string; walls: WallSegment[]; lights: PlacedLight[] }`.
  - `buildGeometry(plan)` returns `{ ok: true; walls; lights; floors: FloorGeometry[]; stairs: PlacedStair[]; footprint: Array<{x:number;y:number;w:number;h:number}> } | { ok: false; errors: string[] }`. `walls`/`lights` stay as floor 0's (back compat). `footprint` is every room of every floor, in cells.
  - `validateFloorplan(plan: Floorplan): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/floorplan.test.ts` (reuse its existing `geo` helper if it parses through `FloorplanSchema`; otherwise define as below). These tests are new; do not edit existing ones yet.

```ts
import { FloorplanSchema, buildGeometry, validateFloorplan } from "./floorplan.js";

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
    expect(() => FloorplanSchema.parse({ name: "x", cols: 8, rows: 6, rooms: ground.rooms, floors: [ground] })).toThrow(/floors.*rooms|rooms.*floors/i);
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
    const noDoor = two({ floors: [{ ...ground, openings: [] }, upper] });
    const out = buildGeometry(noDoor);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toContain("no exterior door");
  });

  it("rejects an upper room that overhangs the floor below", () => {
    const bad = two({ floors: [ground, { ...upper, rooms: [{ id: "bed", x: 10, y: 0, w: 8, h: 6 }] }] });
    const out = buildGeometry(bad);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toMatch(/overhang|outside the floor below/);
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

  it("rejects a stair that leaves its room on the lower or upper floor", () => {
    const out = buildGeometry(two({ stairs: [{ at: [6, 1], dir: "e" }] })); // x 6..8 crosses hall (0..8)? 6,7,8 -> 8 is kitchen
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toMatch(/stair 0.*(inside a single room|leaves)/);
  });

  it("rejects a stair that does not exist on the upper floor", () => {
    const small = two({ floors: [ground, { ...upper, rooms: [{ id: "bed", x: 0, y: 0, w: 4, h: 6 }] }] });
    const out = buildGeometry(small);
    expect(out.ok).toBe(false);
  });

  it("rejects a stair that covers a door or window edge", () => {
    const out = buildGeometry(two({ stairs: [{ at: [2, 5], dir: "e", length: 3 }] })); // row 5 is the hall south wall row; door at s/2
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(" ")).toMatch(/stair 0.*(door|window|wall)/);
  });

  it("rejects overlapping stairs and a floor nobody can reach", () => {
    const overlap = buildGeometry(two({ stairs: [{ at: [1, 1], dir: "e" }, { at: [2, 1], dir: "e" }] }));
    expect(overlap.ok).toBe(false);
    const unreachable = buildGeometry(two({ stairs: [] }));
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) expect(unreachable.errors.join(" ")).toContain("unreachable");
  });

  it("rejects a stair whose upper floor does not exist", () => {
    const out = buildGeometry(two({ stairs: [{ at: [1, 1], dir: "e", from: 1 }] }));
    expect(out.ok).toBe(false);
  });

  it("exposes the footprint of every room of every floor", () => {
    const g = buildGeometry(two());
    expect(g.ok && g.footprint).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/src/floorplan.test.ts`
Expected: FAIL (the new tests fail: `floors` unknown / `stairs` undefined). Existing tests still pass or fail only on type errors you fix in Step 3.

- [ ] **Step 3: Implement**

In `packages/shared/src/floorplan.ts`:

1. Schemas. Replace the `FloorplanSchema` block with:

```ts
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
```

2. Validation. Rename the existing body of `validateFloorplan` into `validateFloor(plan, floor, prefix)` operating on `floor.rooms/openings/lights` (grid size from `plan.cols/rows`), prefixing each message with `prefix` (empty for one floor, `floor "<name>": ` for several). New `validateFloorplan(plan)`:

```ts
export function validateFloorplan(plan: Floorplan): string[] {
  const errors: string[] = [];
  const multi = plan.floors.length > 1;
  plan.floors.forEach((f) => errors.push(...validateFloor(plan, f, multi ? `floor "${f.name}": ` : "")));
  // A floor cannot overhang the one below: every cell of an upper room is a cell of a lower room.
  const cellsOf = (f: Floor) => new Set(f.rooms.flatMap((r) => cellsOfRect(r.x, r.y, r.w, r.h)));
  for (let i = 1; i < plan.floors.length; i++) {
    const below = cellsOf(plan.floors[i - 1]!);
    for (const r of plan.floors[i]!.rooms) {
      if (cellsOfRect(r.x, r.y, r.w, r.h).some((c) => !below.has(c))) errors.push(`floor "${plan.floors[i]!.name}": room "${r.id}" is outside the floor below (a floor cannot overhang)`);
    }
  }
  errors.push(...validateStairs(plan));
  return errors;
}
```

with helpers:

```ts
const cellKey = (x: number, y: number) => `${x},${y}`;
const cellsOfRect = (x: number, y: number, w: number, h: number): string[] => {
  const out: string[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push(cellKey(x + i, y + j));
  return out;
};

export interface PlacedStair { from: number; to: number; x: number; y: number; w: number; h: number; dir: Stair["dir"] }
export function placeStair(s: Stair): PlacedStair {
  const along = s.length;
  const across = s.width;
  const horizontal = s.dir === "e" || s.dir === "w";
  return { from: s.from, to: s.from + 1, x: s.at[0], y: s.at[1], w: horizontal ? along : across, h: horizontal ? across : along, dir: s.dir };
}
```

`validateStairs(plan)`: for each stair i (`stair ${i}: ...`):
- `to` floor must exist (`from + 1 < floors.length`), else error "joins floor X to a floor that does not exist".
- Footprint cells must all lie inside ONE room of floor `from` and ONE room of floor `to` (find the room that contains the first cell, require it contains all); else "stair i must lie inside a single room on both floors it joins".
- Must not cover a door or window edge: for each opening of both floors, compute `openingEdges` edges; a stair rectangle "covers" an edge if the edge lies on its boundary or interior (edge `h:x:y` touches cells (x,y-1) and (x,y); `v:x:y` touches (x-1,y) and (x,y)); error "stair i covers a door or window". Because a stair must be inside one room, the only edges it can touch are that room's walls: a stair against a wall is allowed, only an opening edge that is adjacent to a stair cell inside that room is rejected.
- No overlap between stairs with the same `from` (shared cell → "stairs i and j overlap").
- Reachability: for floor k ≥ 1, some stair has `to === k`, else `floor "<name>" is unreachable (no stair leads to it)`.

3. Geometry. Turn the existing `buildGeometry` body into `floorGeometry(plan, floor, isGround)` returning `{ ok:false, errors } | { ok:true, walls, lights }` using `floor.rooms/openings/lights`, with the exterior-door error only `if (isGround && exteriorDoors === 0)`. Then:

```ts
export interface FloorGeometry { name: string; walls: WallSegment[]; lights: PlacedLight[] }

export function buildGeometry(plan: Floorplan):
  | { ok: true; walls: WallSegment[]; lights: PlacedLight[]; floors: FloorGeometry[]; stairs: PlacedStair[]; footprint: Array<{ x: number; y: number; w: number; h: number }> }
  | { ok: false; errors: string[] } {
  const errors = validateFloorplan(plan);
  if (errors.length) return { ok: false, errors };
  const floors: FloorGeometry[] = [];
  for (let i = 0; i < plan.floors.length; i++) {
    const f = plan.floors[i]!;
    const g = floorGeometry(plan, f, i === 0);
    if (!g.ok) return { ok: false, errors: plan.floors.length > 1 ? g.errors.map((e) => `floor "${f.name}": ${e}`) : g.errors };
    floors.push({ name: f.name, walls: g.walls, lights: g.lights });
  }
  const footprint = plan.floors.flatMap((f) => f.rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })));
  return { ok: true, walls: floors[0]!.walls, lights: floors[0]!.lights, floors, stairs: plan.stairs.map(placeStair), footprint };
}
```

Keep `sideLength` exported. Fix any compile errors in other packages (`floorplan-render.ts`, `floorplan-tools.ts`, `floorplan-finish.ts` read `plan.rooms`): for this task only make them compile by using `plan.floors[0]!.rooms` where they read `plan.rooms` (the real multi-floor use comes in Tasks 2 to 5). Do not change behavior.

- [ ] **Step 4: Run to verify**

Run: `npx vitest run packages/shared/src/floorplan.test.ts && npm run typecheck`
Expected: PASS. If an existing test asserted an exact old-style message, it must still pass (single-floor has no prefix). The two existing assertions on `doorOptions` stay as they are.

- [ ] **Step 5: Whole suite and commit**

```bash
npm test 2>&1 | tail -5
git add -A && git commit -m "Floorplan geometry: several floors, stairs and overhang checks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: all tests pass.

---

### Task 2: Draw stairs, the roof footprint and the roof mask

**Files:**
- Modify: `packages/mcp-server/src/floorplan-render.ts`
- Modify: `packages/mcp-server/test/unit/floorplan-render.test.ts` (path: `test/unit/floorplan-render.test.ts` in the repo root test dir; use whichever exists)

**Interfaces:**
- Consumes: `Floorplan`, `PlacedStair`, `WallSegment`, `PlacedLight`, `footprint` rects from Task 1.
- Produces:
  - `renderGuide(plan, walls, opts?: { floor?: number; stairs?: PlacedStair[] }): Buffer` (default floor 0; draws only the stairs that touch that floor: `from === floor` or `to === floor`).
  - `renderOverlay(plan, walls, lights, stairs?: PlacedStair[]): Buffer` (stairs outlined in magenta).
  - `renderRoofGuide(plan, footprint, eaveCells?: number): Buffer` (white footprint + eave on black, full scene size).
  - `maskToFootprint(picture: string, maskPng: string, out: string): Promise<void>`.
  - Constants `STAIR: Rgba = [230, 190, 60, 255]`.

- [ ] **Step 1: Write the failing tests** (append; use the file's existing `Raster`/PNG decode helpers; if it decodes PNG by reading pixels through a small helper, reuse it, otherwise decode via the existing `Raster`-based test helper `pixelAt(png, x, y)`)

```ts
it("draws a stair in the guide on both floors it joins, in its own colour", () => {
  const plan = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, pxPerCell: 50, floors: [
    { name: "G", rooms: [{ id: "a", x: 0, y: 0, w: 8, h: 6 }], openings: [{ room: "a", side: "s", at: 1, kind: "door" }] },
    { name: "U", rooms: [{ id: "b", x: 0, y: 0, w: 8, h: 6 }] },
  ], stairs: [{ at: [2, 2], dir: "e" }] });
  const g = buildGeometry(plan);
  if (!g.ok) throw new Error(g.errors.join());
  for (const floor of [0, 1]) {
    const png = renderGuide(plan, g.floors[floor]!.walls, { floor, stairs: g.stairs });
    expect(pixelAt(png, 2 * 50 + 25, 2 * 50 + 25)).toEqual([230, 190, 60, 255]);
  }
});

it("a stair is not drawn on a floor it does not touch", () => {
  const plan = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, pxPerCell: 50, floors: [
    { name: "G", rooms: [{ id: "a", x: 0, y: 0, w: 8, h: 6 }], openings: [{ room: "a", side: "s", at: 1, kind: "door" }] },
    { name: "U", rooms: [{ id: "b", x: 0, y: 0, w: 8, h: 6 }] },
    { name: "T", rooms: [{ id: "c", x: 0, y: 0, w: 8, h: 6 }] },
  ], stairs: [{ at: [2, 2], dir: "e" }, { at: [2, 2], dir: "e", from: 1 }] });
  const g = buildGeometry(plan);
  if (!g.ok) throw new Error(g.errors.join());
  const only = g.stairs.filter((s) => s.from === 0);
  const png = renderGuide(plan, g.floors[2]!.walls, { floor: 2, stairs: only });
  expect(pixelAt(png, 125, 125)).not.toEqual([230, 190, 60, 255]);
});

it("the roof guide is white over every room plus the eave, black elsewhere", () => {
  const plan = FloorplanSchema.parse({ name: "S", cols: 10, rows: 8, pxPerCell: 50, rooms: [{ id: "a", x: 2, y: 2, w: 4, h: 3 }] });
  const png = renderRoofGuide(plan, [{ x: 2, y: 2, w: 4, h: 3 }], 0.4);
  expect(pixelAt(png, 3 * 50, 3 * 50)).toEqual([255, 255, 255, 255]);          // inside
  expect(pixelAt(png, 2 * 50 - 10, 3 * 50)).toEqual([255, 255, 255, 255]);     // inside the 20 px eave
  expect(pixelAt(png, 2 * 50 - 30, 3 * 50)).toEqual([0, 0, 0, 255]);           // beyond the eave
  expect(pixelAt(png, 0, 0)).toEqual([0, 0, 0, 255]);
});

it("renderOverlay outlines stairs in magenta", () => {
  const plan = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, pxPerCell: 50, rooms: [{ id: "a", x: 0, y: 0, w: 8, h: 6 }] });
  const png = renderOverlay(plan, [], [], [{ from: 0, to: 1, x: 2, y: 2, w: 3, h: 1, dir: "e" }]);
  expect(pixelAt(png, 2 * 50 + 2, 2 * 50 + 25)[3]).toBeGreaterThan(0);
});
```

If `pixelAt` does not exist in the test file, add it: decode the PNG the module itself writes (use `zlib.inflateSync` over the concatenated IDAT chunks; filter byte is always 0 as written by `Raster.toPng`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/floorplan-render.test.ts`
Expected: FAIL (`renderRoofGuide` is not exported / stair pixel not drawn).

- [ ] **Step 3: Implement**

In `floorplan-render.ts`:

```ts
const STAIR: Rgba = [230, 190, 60, 255];
const OV_STAIR: Rgba = [230, 60, 230, 255];

function drawStairs(r: Raster, stairs: PlacedStair[], px: number, colour: Rgba, outline: boolean): void {
  for (const s of stairs) {
    if (!outline) {
      r.fillRect(s.x * px, s.y * px, s.w * px, s.h * px, colour);
      // treads: thin darker lines across the walking direction
      const horizontal = s.dir === "e" || s.dir === "w";
      const steps = horizontal ? s.w : s.h;
      for (let i = 1; i < steps; i++) {
        if (horizontal) r.fillRect((s.x + i) * px - 1, s.y * px, 3, s.h * px, [120, 90, 30, 255]);
        else r.fillRect(s.x * px, (s.y + i) * px - 1, s.w * px, 3, [120, 90, 30, 255]);
      }
    } else {
      const t = 4;
      r.fillRect(s.x * px, s.y * px, s.w * px, t, colour);
      r.fillRect(s.x * px, (s.y + s.h) * px - t, s.w * px, t, colour);
      r.fillRect(s.x * px, s.y * px, t, s.h * px, colour);
      r.fillRect((s.x + s.w) * px - t, s.y * px, t, s.h * px, colour);
    }
  }
}
```

Change `renderGuide` to `renderGuide(plan, walls, opts = {})`: use `const floor = plan.floors[opts.floor ?? 0]!`, iterate `floor.rooms`, draw rooms and walls as now, then `drawStairs(r, (opts.stairs ?? []).filter((s) => s.from === (opts.floor ?? 0) || s.to === (opts.floor ?? 0)), px, STAIR, false)` (stairs before walls so walls stay on top is fine either way; draw stairs after rooms and before walls). Change `renderOverlay(plan, walls, lights, stairs = [])` to add `drawStairs(r, stairs, px, OV_STAIR, true)`.

```ts
/** White = under the roof (every room of every floor plus an eave), black = open sky. Also the roof's transparency mask. */
export function renderRoofGuide(plan: Floorplan, footprint: Array<{ x: number; y: number; w: number; h: number }>, eaveCells = 0.4): Buffer {
  const px = plan.pxPerCell;
  const r = new Raster(plan.cols * px, plan.rows * px);
  r.fillRect(0, 0, r.width, r.height, [0, 0, 0, 255]);
  const eave = eaveCells * px;
  for (const f of footprint) r.fillRect(f.x * px - eave, f.y * px - eave, f.w * px + 2 * eave, f.h * px + 2 * eave, [255, 255, 255, 255]);
  return r.toPng();
}

/** Make everything outside the footprint transparent: the guide's white is opaque, its black is clear. */
export async function maskToFootprint(picture: string, maskPng: string, out: string): Promise<void> {
  await run("magick", [picture, "(", maskPng, "-alpha", "off", "-colorspace", "Gray", ")", "-compose", "CopyOpacity", "-composite", out]);
}
```

(`out` should end in `.webp`; ImageMagick keeps alpha in webp.)

- [ ] **Step 4: Run to verify**

Run: `npx vitest run test/unit/floorplan-render.test.ts && npm run typecheck`
Expected: PASS. Update the existing renderGuide/renderOverlay callers (floorplan-tools.ts passes `geo.walls`; keep floor 0 behavior for now).

- [ ] **Step 5: Mask test against real ImageMagick (skipped when `magick` is absent)**

```ts
it.skipIf(!(await hasMagick()))("maskToFootprint clears the outside and keeps the inside", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mask-"));
  const plan = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, pxPerCell: 50, rooms: [{ id: "a", x: 2, y: 2, w: 3, h: 2 }] });
  const mask = join(dir, "mask.png");
  await writeFile(mask, renderRoofGuide(plan, [{ x: 2, y: 2, w: 3, h: 2 }], 0));
  const pic = join(dir, "pic.png");
  await run("magick", ["-size", "400x300", "xc:red", pic]);
  const out = join(dir, "out.webp");
  await maskToFootprint(pic, mask, out);
  const { stdout } = await run("magick", [out, "-format", "%[fx:p{125,125}.a] %[fx:p{10,10}.a]", "info:"]);
  const [inside, outside] = stdout.trim().split(" ").map(Number);
  expect(inside).toBeGreaterThan(0.9);
  expect(outside).toBeLessThan(0.1);
});
```

Run: `npx vitest run test/unit/floorplan-render.test.ts` — Expected: PASS (or skipped without magick).

- [ ] **Step 6: Commit**

```bash
npm test 2>&1 | tail -4
git add -A && git commit -m "Floorplan render: stairs, roof footprint guide and roof mask

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Several images in one job, and `levels` on walls and lights

**Files:**
- Modify: `packages/mcp-server/src/image-gen.ts` (`ImageRequest.parts`, `ImageJobs` runs parts in order)
- Modify: `packages/mcp-server/src/scene-tools.ts` (`levels` on `add_walls` / `add_lights`, export `loadGrid`)
- Modify: `test/integration/mock-foundry.ts` (default level on Scene create for Foundry 14)
- Test: `test/integration/generate-image.test.ts` (parts), `test/integration/scene-tools.test.ts` (levels), `test/integration/floorplan-tool.test.ts` (existing `ensureSceneBackground` test adapts)

**Interfaces:**
- Consumes: `ImageJobs`, `ImageRunner`, `AddWallsShape`, `AddLightsShape`.
- Produces:
  - `ImageRequest.parts?: ImageRequest[]`. When present the job runs `runner(part, signal)` for each part sequentially, then is `done`; any rejection fails the job (earlier files stay). The request's own `outPath` is the first part's.
  - `add_walls` and `add_lights` accept `levels?: string[]` (level ids) written as `levels` on every created document.
  - `loadGrid` exported from `scene-tools.ts`: `export async function loadGrid(transport, sceneId, opts): Promise<GridResult | ToolOutcome>` plus exported `isOutcome` (if not already) and type `GridResult`.
  - MockFoundry: a `Scene` created while `worldInfo.foundryVersion` major is at least 14 gets `levels: [{ _id: "defaultLevel0000", name: "Level", elevation: { bottom: 0, top: 20 }, background: { src: null }, sort: 0 }]` unless the payload has levels.

- [ ] **Step 1: Failing tests**

`generate-image.test.ts`:

```ts
it("runs the parts of one request in order as one job and fails the job when a part fails", async () => {
  const seen: string[] = [];
  const runner: ImageRunner = async (req) => {
    seen.push(req.outPath);
    if (req.outPath.endsWith("b.webp")) throw new ImageRunError("INTERNAL", "boom");
    return { path: req.outPath };
  };
  const jobs = new ImageJobs(runner);
  const mk = (n: string): ImageRequest => ({ prompt: n, width: 10, height: 10, outPath: `/x/${n}.webp` });
  const ok = jobs.start({ ...mk("a"), parts: [mk("a"), mk("c")] }, {});
  await jobs.wait(ok!.id, 1000);
  expect(ok!.status).toBe("done");
  expect(seen).toEqual(["/x/a.webp", "/x/c.webp"]);
  seen.length = 0;
  const bad = jobs.start({ ...mk("a"), parts: [mk("a"), mk("b"), mk("c")] }, {});
  await jobs.wait(bad!.id, 1000);
  expect(bad!.status).toBe("failed");
  expect(seen).toEqual(["/x/a.webp", "/x/b.webp"]);
});
```

`scene-tools.test.ts`:

```ts
it("add_walls and add_lights write levels when given", async () => {
  const { mock, transport } = setup();
  await runAddWalls(transport, { sceneId: "s1", levels: ["L1"], walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] });
  await runAddLights(transport, { sceneId: "s1", levels: ["L1"], lights: [{ col: 1.5, row: 1.5, source: "torch" }] });
  const scene = mock.store.get("!scenes!s1") as any;
  expect(scene.walls.at(-1).levels).toEqual(["L1"]);
  expect(scene.lights.at(-1).levels).toEqual(["L1"]);
});
it("without levels the documents carry no levels field (every level)", async () => {
  const { mock, transport } = setup();
  await runAddWalls(transport, { sceneId: "s1", walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] });
  expect((mock.store.get("!scenes!s1") as any).walls.at(-1).levels).toBeUndefined();
});
```

`floorplan-tool.test.ts` (new test in the `ensureSceneBackground` area): a Foundry 14 mock creates a scene with the default level:

```ts
it("a Foundry 14 scene is created with the default level", async () => {
  const mock = new MockFoundry({ worldInfo: { foundryVersion: "14.368" } });
  const transport = new MockTransport(mock);
  const out = await runCreateScene(transport, { name: "S", width: 100, height: 100 } as never, {});
  const id = (out as any).data._id;
  expect((mock.store.get(`!scenes!${id}`) as any).levels[0]._id).toBe("defaultLevel0000");
});
```

(import `runCreateScene` from `tools.js`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/integration/generate-image.test.ts test/integration/scene-tools.test.ts test/integration/floorplan-tool.test.ts`
Expected: FAIL on the four new tests (unknown `parts`, `levels` ignored by zod strip, no default level).

- [ ] **Step 3: Implement**

`image-gen.ts`: add `parts?: ImageRequest[]` to `ImageRequest` (doc: "A job with parts runs each in order; the request's own fields describe the first"). In `ImageJobs.start`, replace `this.runner(request, abort.signal)` with:

```ts
const run = async (): Promise<void> => {
  const todo = request.parts?.length ? request.parts : [request];
  for (const part of todo) {
    if (abort.signal.aborted) return;
    await this.runner({ ...part, parts: undefined }, abort.signal);
  }
};
const settled = run().then( /* same handlers as before */ );
```

Keep the existing `.then(success, failure)` handlers unchanged (success: `if (job.status === "running") this.finish(job, "done")`).

`scene-tools.ts`: export `loadGrid`/`GridResult`/`isOutcome` if not exported. Add to `AddWallsShape` and `AddLightsShape`: `levels: z.array(z.string().min(1)).optional().describe("Foundry 14: the level ids these belong to; omit for every level")`. In `runAddWalls`: destructure `levels` from args (do not pass into `buildWallFromGrid`), after building `data` do `const withLevels = levels?.length ? data.map((d) => ({ ...d, levels })) : data`. Same in `runAddLights`.

`mock-foundry.ts` `createDocument`: after `const doc: Json = { ...data, _id };` add

```ts
if (type === "Scene" && this.worldInfoMajor() >= 14 && !Array.isArray(doc.levels)) {
  doc.levels = [{ _id: "defaultLevel0000", name: "Level", elevation: { bottom: 0, top: 20 }, background: { src: null }, sort: 0 }];
}
```

and a private `worldInfoMajor()` reading the constructor's `worldInfo.foundryVersion` (find where `getWorldInfo` reads it; default 14 when absent so existing tests behave like Foundry 14). The embedded-id loop below it already gives ids to inline entries.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test 2>&1 | tail -6`
Expected: all pass. If an old test now sees a `levels` field in a scene it deep-compares, update that expectation to include the default level (that is the intended behavior of the mock).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Image jobs with several parts; levels on add_walls and add_lights; default level in the mock

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Build the levels, stairs and roof in Foundry (`finishFloorplan`)

**Files:**
- Modify: `packages/mcp-server/src/floorplan-finish.ts`
- Modify: `packages/mcp-server/src/image-tools.ts` (the `followUp` call site)
- Test: `test/integration/floorplan-tool.test.ts` (a new `describe("build_floorplan_scene: floors, stairs and roof")`; the tool wiring is Task 5, so these tests call `finishFloorplan` directly)

**Interfaces:**
- Consumes: `buildGeometry` output (Task 1), `maskToFootprint`, `renderRoofGuide` (Task 2), `runAddWalls`/`runAddLights` with `levels`, exported `loadGrid` (Task 3), `runCreateEmbedded`, `runUpdateEmbedded`, `runUpdateDocument`, `runFindDocuments`.
- Produces:
  - `FloorplanApply` becomes:
    ```ts
    export interface FloorplanApply {
      to: "floorplanScene";
      plan: Floorplan;
      floors: FloorGeometry[];
      stairs: PlacedStair[];
      footprint: Array<{ x: number; y: number; w: number; h: number }>;
      overlayPaths: string[];        // one per floor
      pictures: { floors: string[]; roof?: string };   // local files: floors in order, roof picture (unmasked)
      roofGuidePath?: string;        // the footprint guide, used as the mask
    }
    ```
  - `FloorplanDeps` gains `maskToFootprint: (picture: string, mask: string, out: string) => Promise<void>`; `realFloorplanDeps` includes the real one.
  - `finishFloorplan(input: { apply: FloorplanApply; source; target; deps? }, transport, opts)` (the old `file` input is removed; the picture list is in `apply.pictures`).
  - Result data: `{ sceneId, levels: Array<{ id: string; name: string }>, stairs: number, roof: { tileId: string; src: string } | null, previews: string[], walls: number, lights: number, src: string, warnings: string[] }` (`src` is floor 0's uploaded path).

- [ ] **Step 1: Failing tests**

Add a helper in the test file that builds an apply for a two-floor plan (use `buildGeometry`, write fake files into a temp dir) and the deps from the existing `setup`. Tests:

```ts
const twoFloors = {
  name: "Tower", cols: 16, rows: 10, pxPerCell: 50,
  floors: [
    { name: "Ground", rooms: [{ id: "hall", x: 1, y: 1, w: 8, h: 8 }, { id: "kitchen", x: 9, y: 1, w: 6, h: 8 }],
      openings: [{ room: "hall", side: "w", at: 3, kind: "door" }, { room: "kitchen", side: "n", at: 2, kind: "window" }],
      lights: [{ at: [2, 4], source: "fireplace" }] },
    { name: "Upstairs", rooms: [{ id: "bed", x: 1, y: 1, w: 8, h: 8 }],
      openings: [{ room: "bed", side: "n", at: 2, kind: "window" }], lights: [{ at: [2, 2], source: "candle" }] },
  ],
  stairs: [{ at: [4, 3], dir: "e" }],
};

it("creates levels, per-level walls and lights, a stair region and a roof tile", async () => {
  const t = await setup({ pictureSize: [800, 500] });
  const out = await t.runFinish(twoFloors);            // helper: apply + finishFloorplan on t.transport
  expect(out.ok).toBe(true);
  const scene = onlyScene(t.mock);
  const [l0, l1] = scene.levels;
  expect(l0).toMatchObject({ _id: "defaultLevel0000", name: "Ground", elevation: { bottom: 0, top: 10 } });
  expect(l1).toMatchObject({ name: "Upstairs", elevation: { bottom: 10, top: 20 } });
  expect(l0.background.src).toMatch(/\.webp$/);
  expect(l1.background.src).toMatch(/\.webp$/);
  expect(scene.walls.filter((w: any) => w.levels[0] === l0._id).length).toBeGreaterThan(0);
  expect(scene.walls.filter((w: any) => w.levels[0] === l1._id).length).toBeGreaterThan(0);
  expect(scene.walls.every((w: any) => w.levels.length === 1)).toBe(true);
  expect(scene.lights.map((l: any) => l.levels[0]).sort()).toEqual([l0._id, l1._id].sort());
  const stair = scene.regions[0];
  expect(stair).toMatchObject({ levels: [l0._id, l1._id], elevation: { bottom: 0, top: 20 } });
  expect(stair.behaviors[0]).toMatchObject({ type: "changeLevel", system: { movementActions: ["walk"] } });
  expect(stair.shapes[0]).toMatchObject({ type: "rectangle", width: 150, height: 50 });
  const roof = scene.tiles[0];
  expect(roof).toMatchObject({ width: 800, height: 500, elevation: 20, levels: [l0._id, l1._id], occlusion: { modes: [1, 8], alpha: 0 } });
  expect(roof.texture.src).toMatch(/roof.*\.webp$/);
  expect(scene.tokenVision).toBe(true);
  expect((out as any).data.levels).toHaveLength(2);
  expect((out as any).data.roof.tileId).toBe(roof._id);
});

it("applies the scene's grid origin to the stair region and the roof tile", async () => {
  const t = await setup({ pictureSize: [800, 500], origin: { x: 50, y: 50 } });   // extend setup: mock scene state origin
  await t.runFinish(twoFloors);
  const scene = onlyScene(t.mock);
  expect(scene.regions[0].shapes[0]).toMatchObject({ x: 4 * 50 + 50, y: 3 * 50 + 50 });
  expect(scene.tiles[0]).toMatchObject({ x: 50, y: 50 });
});

it("masks the roof picture to the footprint before uploading it", async () => {
  const t = await setup({ pictureSize: [800, 500] });
  await t.runFinish(twoFloors);
  expect(t.masked).toHaveLength(1);
  expect(t.masked[0]!.mask).toMatch(/roof-guide/);
  expect(t.mock.filePicker.uploads.some((u: any) => /roof/.test(u.name))).toBe(true);
});

it("skips the roof with a warning when ImageMagick is missing, and still builds the floors", async () => {
  const t = await setup({ magick: false });
  const out = await t.runFinish(twoFloors);
  expect(out.ok).toBe(true);
  const scene = onlyScene(t.mock);
  expect(scene.tiles ?? []).toHaveLength(0);
  expect(scene.levels).toHaveLength(2);
  expect((out as any).data.roof).toBeNull();
  expect((out as any).data.warnings.join(" ")).toMatch(/roof/i);
});

it("roof:false builds no roof tile and no roof upload", async () => {
  const t = await setup();
  await t.runFinish({ ...twoFloors, roof: false });
  expect(onlyScene(t.mock).tiles ?? []).toHaveLength(0);
});

it("a single floor still builds one level, its walls on that level, and a roof", async () => {
  const t = await setup();
  await t.runFinish({ name: "One", cols: 8, rows: 6, pxPerCell: 50, rooms: [{ id: "a", x: 1, y: 1, w: 6, h: 4 }], openings: [{ room: "a", side: "s", at: 1, kind: "door" }] });
  const scene = onlyScene(t.mock);
  expect(scene.levels).toHaveLength(1);
  expect(scene.walls.every((w: any) => w.levels[0] === "defaultLevel0000")).toBe(true);
  expect(scene.tiles).toHaveLength(1);
});

it("is undone by requestId including levels, regions and the roof tile", async () => {
  const t = await setup();
  await t.runFinish(twoFloors);
  const undone = await runUndoChange(t.log, t.transport, { requestId: "req-build_floorplan_scene" }, t.callOpts("undo_change"));
  expect(undone.ok).toBe(true);
  expect([...t.mock.store.keys()].some((k) => k.startsWith("!scenes!"))).toBe(false);
});
```

`setup` additions: `origin` option (the mock's `sceneState` origin approximation: check how `MockFoundry` computes `origin`, and add an option or set `scene.padding`/`shiftX` so the origin is (50,50) for this test), a `masked: Array<{picture, mask, out}>` recorder in `deps.maskToFootprint`, and `runFinish(plan)` that does:

```ts
const runFinish = async (input: unknown) => {
  const plan = FloorplanSchema.parse(input);
  const geo = buildGeometry(plan); if (!geo.ok) throw new Error(geo.errors.join());
  const d = outputDir; await mkdir(d, { recursive: true });
  const floors = geo.floors.map((_, i) => join(d, `floor-${i}.webp`));
  for (const f of floors) await writeFile(f, "x");
  const roof = join(d, "roof-pic.webp"); await writeFile(roof, "x");
  const guide = join(d, "roof-guide.png"); await writeFile(guide, "x");
  const apply: FloorplanApply = { to: "floorplanScene", plan, floors: geo.floors, stairs: geo.stairs, footprint: geo.footprint,
    overlayPaths: floors.map((_, i) => join(d, `overlay-${i}.png`)), pictures: { floors, roof: plan.roof ? roof : undefined }, roofGuidePath: guide };
  return finishFloorplan({ apply, source: "data", target: "generated-images", deps }, transport, callOpts("build_floorplan_scene"));
};
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/integration/floorplan-tool.test.ts`
Expected: FAIL (`apply.pictures` unknown, no levels created).

- [ ] **Step 3: Implement**

Rewrite `finishFloorplan` as these ordered stages (keep the existing `fail` helper, the `steps` list and `warnings` array, and the "upload" naming `floorplan-<stamp>`):

1. **Pictures**: for each `apply.pictures.floors[i]`, when `deps.hasMagick()`: check `imageSize` and `fitImage` to `cols*px × rows*px` as the current code does (one warning per resized picture, say which floor). If `pictures.roof` and magick: fit it, then `deps.maskToFootprint(roofPic, apply.roofGuidePath!, maskedPath)` where `maskedPath = roofPic.replace(/\.[a-z]+$/, "-masked.webp")` and use that for the upload. If `pictures.roof` and no magick: `warnings.push("ImageMagick (magick) was not found: the roof was skipped (it needs the picture masked to the house outline)")` and treat the roof as absent.
2. **Upload** each picture (`runUploadAsset`, filename `floorplan-${showImageFilename(`${plan.name}-${floorName}`, ext)}`, roof `roof-${...}`), collect `src` paths.
3. **Scene**: `runCreateScene({ name, width, height, gridSize, gridDistance, background: floorSrcs[0] })`, then `runUpdateDocument(transport, { documentType: "Scene", id: sceneId, data: { tokenVision: true } }, opts)`.
4. **Levels**: `runFindDocuments({ documentType: "Scene", id: sceneId, fields: ["_id", "levels"] })`; the first level's `_id` is the ground level id (expect `defaultLevel0000`; use whatever Foundry returns). `runUpdateEmbedded` Level `[{ _id: groundId, name: floors[0].name, "elevation.bottom": 0, "elevation.top": 10, "background.src": floorSrcs[0], sort: 0 }]`. For floors 1..n-1: `runCreateEmbedded` Level `data: [{ name, elevation: {bottom: 10*i, top: 10*i+10}, sort: i, background: { src: floorSrcs[i] } }]`, `fields: ["_id","name"]`; read the created ids from the result (`data` is an array of `{_id,...}` for createEmbedded; check `createEmbeddedReliable`'s return and adapt). If the scene has no levels (a defensive case) fail with `INTERNAL`.
5. **Walls and lights per floor**: `runAddWalls({ sceneId, levels: [levelIds[i]], walls: floor.walls.map(...) })` and `runAddLights({ sceneId, levels: [levelIds[i]], lights: ... })` (same mapping as today).
6. **Stairs**: `const grid = await loadGrid(transport, sceneId, opts)` (fail through if it returns an outcome). For each stair: region data
   ```ts
   { name: `Stairs ${i + 1}`, color: "#e6be3c",
     shapes: [{ type: "rectangle", x: s.x * size + origin.x, y: s.y * size + origin.y, width: s.w * size, height: s.h * size, rotation: 0, hole: false }],
     levels: [levelIds[s.from], levelIds[s.to]],
     elevation: { bottom: 10 * s.from, top: 10 * (s.to + 1) },
     behaviors: [{ type: "changeLevel", name: "Change level", system: { movementActions: ["walk"] } }] }
   ```
   in one `runCreateEmbedded` Region call.
7. **Roof** (when a masked roof exists): `runCreateEmbedded` Tile `{ x: origin.x, y: origin.y, width, height, elevation: 10 * floors.length, levels: levelIds, texture: { src: roofSrc }, occlusion: { modes: [1, 8], alpha: 0 }, restrictions: { light: false, weather: false } }`; keep the returned tile id.
8. **Previews**: for each floor with magick, `compositePreview(pictures.floors[i], overlayPaths[i], overlayPaths[i].replace(/overlay-/, "preview-"))`.
9. Return the data shape listed in Interfaces. Append `steps` entries `"levels"`, `"stairs"`, `"roof"` as they run.

Make `fail` calls propagate with `{ ...out, steps: [...steps, ...out.steps] }` exactly like the current code.

`image-tools.ts` `followUp`: `return finishFloorplan({ apply, source, target, deps }, transport, opts)` (drop `file`).

`realFloorplanDeps`: add `maskToFootprint` imported from `./floorplan-render.js`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/integration/floorplan-tool.test.ts && npm run typecheck`
Expected: PASS for the new and the existing tests. The old tests construct the apply through the tool, so they fail to compile until Task 5; to keep this task green on its own, in this task also adapt `runBuildFloorplanScene` minimally: build `apply` with `floors: geo.floors, stairs: geo.stairs, footprint: geo.footprint, overlayPaths: [overlayPath], pictures: { floors: [file] }` where `file` is the guide (codex:false) or the single picture. Task 5 then finishes the real multi-image flow.

- [ ] **Step 5: Commit**

```bash
npm test 2>&1 | tail -5
git add -A && git commit -m "finishFloorplan builds levels, per-level walls and lights, stair regions and the roof tile

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The tool: prompts, guides and one job for every picture

**Files:**
- Modify: `packages/mcp-server/src/floorplan-tools.ts`
- Modify: `packages/mcp-server/src/server.ts` (tool description text only if it mentions floors; the schema comes from `FloorplanSceneShape`)
- Test: `test/integration/floorplan-tool.test.ts`, `test/unit/floorplan-prompt.test.ts` (new, pure prompt tests)

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces:
  - `FloorplanSceneShape = { ...FloorplanBaseSchema.shape, source, target, waitSeconds }` (the base object's shape, so `rooms` is optional and `floors`/`stairs`/`roof`/`roofStyle` are tool parameters).
  - `buildFloorplanPrompt(plan: Floorplan, floor = 0, stairs: PlacedStair[] = []): string`.
  - `buildRoofPrompt(plan: Floorplan): string`.
  - `runBuildFloorplanScene` starts ONE job whose `parts` are the floor pictures then the roof picture, with `FloorplanApply.pictures` and `roofGuidePath` set.

- [ ] **Step 1: Failing tests**

`test/unit/floorplan-prompt.test.ts`:

```ts
it("the floor prompt lists that floor's rooms and explains the stairs", () => {
  const plan = FloorplanSchema.parse(twoFloorsInput);
  const g = buildGeometry(plan); if (!g.ok) throw new Error();
  const ground = buildFloorplanPrompt(plan, 0, g.stairs);
  expect(ground).toContain("hall");
  expect(ground).not.toContain("bed");
  expect(ground).toMatch(/yellow.*staircase.*up/i);
  const up = buildFloorplanPrompt(plan, 1, g.stairs);
  expect(up).toContain("bed");
  expect(up).toMatch(/yellow.*(top of a staircase|balustrade)/i);
});
it("the roof prompt asks for a top-down roof of the chosen style over the white shape only", () => {
  const p = buildRoofPrompt(FloorplanSchema.parse({ ...twoFloorsInput, roofStyle: "slate roof" }));
  expect(p).toContain("slate roof");
  expect(p).toMatch(/white/i);
  expect(p).toMatch(/black/i);
  expect(p).not.toMatch(/furnish/i);
});
it("a single-floor prompt keeps the old wording (no stairs paragraph)", () => {
  const plan = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, rooms: [{ id: "a", x: 1, y: 1, w: 6, h: 4, furnishings: ["bed"] }] });
  expect(buildFloorplanPrompt(plan)).not.toMatch(/staircase/i);
});
```

`floorplan-tool.test.ts` (through `t.run`, like the existing tests, with the fake runner recording requests):

```ts
it("a two-floor house with a roof is one job with three images: floor, floor, roof", async () => {
  const t = await setup({ pictureSize: [800, 500] });
  const out = await t.run(twoFloors);
  expect(out.ok).toBe(true);
  expect(t.requests.map((r) => r.outPath.split("/").pop()!.replace(/^[^-]*-/, ""))).toHaveLength(3);
  expect(t.requests[0]!.prompt).toContain("hall");
  expect(t.requests[1]!.prompt).toContain("bed");
  expect(t.requests[2]!.prompt).toMatch(/roof/i);
  expect(t.requests.every((r) => r.guidePath)).toBe(true);
  expect(onlyScene(t.mock).levels).toHaveLength(2);
});
it("roof:false is two images; a one-floor house without a roof is one image like before", async () => {
  const t = await setup();
  await t.run({ ...twoFloors, roof: false });
  expect(t.requests).toHaveLength(2);
  const u = await setup();
  await u.run({ ...house, roof: false });
  expect(u.requests).toHaveLength(1);
});
it("codex:false uses the blueprints as pictures: no Codex run, levels still built", async () => {
  const t = await setup();
  const out = await t.run({ ...twoFloors, codex: false });
  expect(out.ok).toBe(true);
  expect(t.requests).toHaveLength(0);
  expect(onlyScene(t.mock).levels).toHaveLength(2);
});
it("rejects an invalid stair before any Codex run", async () => {
  const t = await setup();
  const out = await t.run({ ...twoFloors, stairs: [] });
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error.message).toContain("unreachable");
  expect(t.requests).toHaveLength(0);
});
it("a failing image fails the whole job and builds no scene", async () => { /* runner throws on the 2nd request; expect not ok and no scene in the store */ });
```

Existing tests in this file that pass `house` (single floor, roof now defaults to true) will now see 2 requests and a roof; update those that count `t.requests` or check one request by adding `roof: false` to `house`'s usage, except tests that intend to cover the default (the new tests above). Each such edit is a deliberate consequence of `roof` defaulting to true; note it in the commit message.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/floorplan-prompt.test.ts test/integration/floorplan-tool.test.ts`
Expected: FAIL (`buildRoofPrompt` missing; one request only).

- [ ] **Step 3: Implement**

`buildFloorplanPrompt(plan, floor = 0, stairs = [])`: same text as today but built from `plan.floors[floor].rooms`; when `plan.floors.length > 1` add "This is the <floor name> of a <n>-storey building." and, for stairs that touch this floor: lower floor (`s.from === floor`): "The yellow area with treads is a staircase leading up: paint a wooden staircase climbing toward the <dir> side."; upper floor (`s.to === floor`): "The yellow area is the top of a staircase coming up from below: paint the stair opening with a balustrade, stairs descending toward the <opposite dir>." When `stairs` has none for this floor, no staircase text.

```ts
export function buildRoofPrompt(plan: Floorplan): string {
  return (
    `Paint the ${plan.roofStyle} of a ${plan.style} as a strictly top-down orthographic view for a tabletop RPG map, exactly filling the white shape in the attached guide. ` +
    "Keep the outline of the white shape exactly; everything black in the guide stays plain black. " +
    "Show the roof surface with ridge lines and weathering, a chimney above each fireplace, and nothing else: no walls, no interior, no ground, no grid lines, no text, no characters, no UI."
  );
}
```

`runBuildFloorplanScene`: parse with `FloorplanSchema` (the tool args are parsed by `z.object(FloorplanSceneShape)` first, then `FloorplanSchema.parse(spec)` as now; the superRefine errors become a VALIDATION outcome: wrap in try/catch `ZodError` → `fail("VALIDATION", message)`). After `buildGeometry`: for each floor i write `guide-<stamp>-f<i>.png` via `renderGuide(plan, g.floors[i].walls, { floor: i, stairs: geo.stairs })` and `overlay-<stamp>-f<i>.png` via `renderOverlay(plan, walls, lights, stairs touching the floor)`; when `plan.roof` write `roof-guide-<stamp>.png` via `renderRoofGuide(plan, geo.footprint)`. Picture paths: `floorplan-<stamp>-f<i>.webp` and `roof-<stamp>.webp`. `apply` per Task 4. `codex:false`: `pictures.floors` are the guide PNGs, `pictures.roof` is the roof guide PNG (masked to itself, which gives a white roof tile; acceptable for the no-Codex preview) and call `finishFloorplan` directly. Otherwise build `parts` (floors then roof; each with prompt, width, height, `outPath`, `guidePath`; roof prompt `buildRoofPrompt(plan)`), request = `{ ...parts[0], parts }`, `jobs.start(request, { kind: "battlemap", subject: plan.name, apply, source, target })`, then `settleJob` as today. Add the seed line to every prompt when `plan.seed`.

Per-floor `overlayPaths` and previews: pass through `apply.overlayPaths`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test 2>&1 | tail -6 && npm run selftest 2>&1 | tail -3`
Expected: all pass, selftest ends `SELFTEST PASSED`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "build_floorplan_scene: floors, stairs and roof as one multi-image job

roof now defaults to true, so single-floor callers get a roof unless roof:false.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, live suite, and the two-storey Thornwick Cottage

**Files:**
- Modify: `README.md` (bridge) tool docs for `build_floorplan_scene`, `add_walls`/`add_lights` `levels`
- Modify: `docs/superpowers/specs/2026-10-13-floorplan-levels-design.md` (only to correct anything the build proved wrong)
- Modify (curse-of-strahd repo `/Volumes/projects/curse-of-strahd`, new branch off `feature/floorplan-live-test` or `main` after #53 merges): `scripts/lib/bridge-live/suites.mjs` group 9, `docs/bridge-live-test.md`

**Interfaces:**
- Consumes: the finished tool.
- Produces: documentation, a live check, a worked example scene.

- [ ] **Step 1: README**: document `floors`, `stairs`, `roof`, `roofStyle`, the per-floor pictures and the 3-image cost, the roof behavior (VISION + FADE) and the `levels` parameter. Keep the existing example for one floor and add a two-floor example.

- [ ] **Step 2: Live suite group 9**: with the fake Codex build a 2-floor house and assert via `ctx.read("Scene", id, ["levels","walls","lights","regions","tiles","tokenVision"])`: 2 levels with elevations 0 to 10 and 10 to 20 and non-empty `background.src`; every wall and light has exactly one level id and both levels have some; one region with `changeLevel`, `levels` equal to both ids; one tile with `occlusion.modes` `[1, 8]` and `levels` of both ids; `tokenVision` true; cleanup deletes the scene. Skip under `--with-codex` as before.

- [ ] **Step 3: Run the bridge checks and the live suite**: `npm run typecheck && npm test && npm run selftest` in the bridge; in the curse repo `npm run test:bridge-live:all -- --only floorplan --expect-world "<test world title>"` (the user's test world is Test-mcp; the relay port 8787 must be free; if the foundry MCP server of this session holds it, ask the user to restart without it). Expected: the group passes (fake Codex).

- [ ] **Step 4: Build the cottage**: write the two-storey Thornwick Cottage input into the scratchpad (ground: great hall 10x6 with the stair at the hall's west end, kitchen, pantry; upstairs: bedroom, study, landing; windows on both floors; fireplace and torches per floor) on the same 18x12 footprint at 100 px, and run `build_floorplan_scene` for real with `IMAGE_GEN_CODEX_MODEL=gpt-5.5` (the default Codex model is rejected for ChatGPT accounts). Name the scene `Thornwick Cottage (2 floors)`; leave the old single-floor scene alone.

- [ ] **Step 5: Verify by hand in Foundry (Test-mcp)** through the open browser tab (Chrome tab group of this session; `tabs_context_mcp` first): switch to the scene; view from outside (roof opaque; the interior hidden); drop a token inside the house and confirm the roof fades; use the stairs (dialog, token moves to the upper level; the upper picture shows); look through a window from outside with a token and confirm only a slice of the interior shows. Take screenshots of each state, fix what is wrong in the tool (new failing test first for any code bug), and record the outcome.

- [ ] **Step 6: Push and update the PRs**: push `feature/floorplan-levels` and open a PR into `spec/floorplan-scene` (or main if #20 is merged by then); push the curse-repo change and open its PR. Do not merge.

```bash
git add -A && git commit -m "Docs and live check for floorplan levels, stairs and roof

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
