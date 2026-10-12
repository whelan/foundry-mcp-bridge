# Floorplan Scene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `build_floorplan_scene` MCP call turns a small floorplan spec into a Foundry scene: a Codex-painted webp floorplan, walls, animated doors, windows and animated lights that line up with the picture.

**Architecture:** A pure geometry module in `packages/shared` derives walls and lights from the spec. A PNG renderer in `packages/mcp-server` draws a blueprint guide (attached to Codex with `-i`) and an alignment overlay. The tool reuses the existing image-job flow (`generate_image` / `check_image_job`) and adds one new follow-up that uploads the webp, creates the scene, then batch-creates walls and lights.

**Tech Stack:** TypeScript, zod, vitest, node:zlib (PNG writer), ImageMagick `magick` (resize and composite, already required by `gen-image.mjs` for conversion), Codex CLI.

**Spec:** `docs/superpowers/specs/2026-10-12-floorplan-scene-design.md`

## Global Constraints

- Square grids only; axis-aligned rectangular rooms; coordinates are whole grid cells.
- Foundry 14 shapes (verified live on 14.368): door `animation` = `{type, direction, double, flip, duration, strength}`; `type` is one of `swing, slide, swivel, ascend, descend`; `direction` is `-1` or `1` (default `1`); `duration` default `750`; `strength` 0 to 2 (default `1`); door state `ds` is `0` closed, `1` open, `2` locked.
- A window is a wall with `move: 20` (blocks movement), `sight: 0`, `light: 0` (see-through, light passes), `sound: 20`. No `threshold`, no `DISTANCE` sense (this replaces the spec's DISTANCE wording; Task 2 edits the spec).
- Exterior edges are derived from the rooms, never declared. The spec's `exterior` and `state` opening fields are replaced by derived exteriority and `open?: boolean`.
- `packages/shared` must stay browser-safe (the Foundry module bundles it): no `node:*` imports there. Anything that touches PNG, files, `magick` or `codex` lives in `packages/mcp-server`.
- Existing behaviour of `add_walls`, `add_lights`, `generate_image` and the existing tests must not change: new fields are optional and only written when given.
- Embedded writes go through `createEmbeddedReliable` (read-back verified, logged, undoable by `requestId`).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Verification before every commit: `npm run typecheck && npm test`.

## Review Focus

- Two rooms with a gap between them (not adjacent): both keep full exterior walls; no wall is shared. Pinned in Task 3.
- An opening declared on the same shared edge from both rooms: rejected as an overlap, not silently doubled. Pinned in Task 3.
- An opening wider than its wall, or starting past its end: rejected with a message naming the room and side. Pinned in Task 2.
- A house with no exterior door: rejected (nobody could enter). Pinned in Task 3.
- Codex returning an image whose pixel size differs from `cols x pxPerCell` by `rows x pxPerCell`: the file is resized to exactly that size and the result carries a warning, so walls never drift by a scale factor. Pinned in Task 6.
- The webp is uploaded as `image/webp` with a `.webp` name (the existing follow-up hard-codes PNG). Pinned in Task 6.
- `magick` missing: the tool still builds the scene and returns the overlay as a separate PNG instead of failing. Pinned in Task 6.
- A Foundry 13 world: animated doors are refused with `UNSUPPORTED` instead of writing fields Foundry drops. Pinned in Task 6.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/scene-builders.ts` (modify) | `window` wall kind, door options, light presets, `resolveLightInput` |
| `packages/shared/src/floorplan.ts` (create) | `FloorplanSchema`, `validateFloorplan`, `buildGeometry` (walls + lights from the spec). Pure. |
| `packages/shared/src/index.ts` (modify) | export `floorplan.js` |
| `packages/mcp-server/src/scene-tools.ts` (modify) | expose window, door options and light animation on `add_walls` / `add_lights` |
| `packages/mcp-server/src/floorplan-render.ts` (create) | `Raster` + RGBA PNG writer, `renderGuide`, `renderOverlay`, `fitImage`, `compositePreview` |
| `packages/mcp-server/src/image-gen.ts` (modify) | `ImageRequest.guidePath`, `buildGenImageArgs` passes `--image` |
| `scripts/gen-image.mjs` (modify) | `--image <file>` attaches the guide with `codex exec -i` |
| `packages/mcp-server/src/floorplan-tools.ts` (create) | `build_floorplan_scene`: validate, guide, start job, follow-up |
| `packages/mcp-server/src/image-tools.ts` (modify) | new apply variant `floorplanScene`, mime from file extension |
| `packages/mcp-server/src/server.ts` (modify) | register `build_floorplan_scene` |
| `test/integration/floorplan-tool.test.ts` (create) | tool end to end with mock Foundry and a fake image runner |
| `docs/bridge-live-test.md`, README (modify) | document the tool and the live group |

The curse-of-strahd repo (`scripts/lib/bridge-live/suites.mjs`) owns the live test and the vendored `generate-image/gen-image.mjs`; Task 8 covers the follow-up there.

---

### Task 1: Windows, door options and light animation in the builders and the existing tools

**Files:**
- Modify: `packages/shared/src/scene-builders.ts` (constants near line 266, `WallKind`, `buildWallFromGrid`, add light presets after `buildLight`)
- Modify: `packages/mcp-server/src/scene-tools.ts` (`AddWallsShape`, `AddLightsShape`, `runAddWalls`, `runAddLights`)
- Test: `packages/shared/src/scene-builders.test.ts`, `test/integration/scene-tools.test.ts`

**Interfaces:**
- Produces (shared): `WALL_DOOR_STATES`, `type DoorAnimationType`, `interface DoorOptions { animation?: DoorAnimationType; double?: boolean; flip?: boolean; direction?: 1 | -1; duration?: number; strength?: number; locked?: boolean; open?: boolean }`, `WallKind` gains `"window"`, `buildWallFromGrid(seg: { x1; y1; x2; y2; kind?: WallKind; doorOptions?: DoorOptions }, gridSize, origin)`, `type LightSource`, `LIGHT_PRESETS`, `resolveLightInput(l: LightInputLike): { bright: number; dim: number; color: string | null; animation: { type: string | null; speed: number; intensity: number } }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/scene-builders.test.ts` (add `buildWallFromGrid, resolveLightInput, LIGHT_PRESETS` to the existing import list):

```ts
describe("buildWallFromGrid: windows and doors", () => {
  it("makes a window that blocks movement but not sight or light", () => {
    const w = buildWallFromGrid({ x1: 0, y1: 0, x2: 2, y2: 0, kind: "window" }, 100, {});
    expect(w).toMatchObject({ door: 0, move: 20, sight: 0, light: 0, sound: 20, c: [0, 0, 200, 0] });
  });

  it("leaves a plain door without an animation block", () => {
    const d = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door" }, 100, {});
    expect(d.animation).toBeUndefined();
    expect(d.ds).toBe(0);
  });

  it("writes the v14 animation block when door options are given", () => {
    const d = buildWallFromGrid(
      { x1: 0, y1: 0, x2: 2, y2: 0, kind: "door", doorOptions: { animation: "slide", double: true } },
      100,
      {},
    );
    expect(d.animation).toEqual({ type: "slide", direction: 1, double: true, flip: false, duration: 750, strength: 1 });
  });

  it("locks and opens doors through ds", () => {
    const locked = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door", doorOptions: { locked: true } }, 100, {});
    const open = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door", doorOptions: { open: true } }, 100, {});
    expect([locked.ds, open.ds]).toEqual([2, 1]);
  });
});

describe("light presets", () => {
  it("a fireplace flickers with the flame animation", () => {
    const l = resolveLightInput({ source: "fireplace" });
    expect(l).toMatchObject({ bright: 15, dim: 30, color: "#ff7a2e", animation: { type: "flame" } });
  });

  it("explicit values override the preset", () => {
    const l = resolveLightInput({ source: "torch", bright: 30, color: "#ffffff", animation: "pulse" });
    expect(l).toMatchObject({ bright: 30, dim: 40, color: "#ffffff", animation: { type: "pulse" } });
  });

  it("no source and no values means no light radius and no animation", () => {
    expect(resolveLightInput({})).toEqual({ bright: 0, dim: 0, color: null, animation: { type: null, speed: 5, intensity: 5 } });
  });

  it("has a preset for every documented source", () => {
    expect(Object.keys(LIGHT_PRESETS).sort()).toEqual(["candle", "daylight", "fireplace", "lantern", "torch"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/shared/src/scene-builders.test.ts`
Expected: FAIL (`resolveLightInput` / `LIGHT_PRESETS` not exported, window kind falls through to a normal wall).

- [ ] **Step 3: Implement in `scene-builders.ts`**

Replace the block from `export const WALL_MOVEMENT_TYPES` through the end of `buildWallFromGrid` with:

```ts
export const WALL_MOVEMENT_TYPES = { NONE: 0, NORMAL: 20 } as const;
export const WALL_SENSE_TYPES = { NONE: 0, LIMITED: 10, NORMAL: 20 } as const;
export const WALL_DOOR_TYPES = { NONE: 0, DOOR: 1, SECRET: 2 } as const;
/** CONST.WALL_DOOR_STATES (Foundry 14). */
export const WALL_DOOR_STATES = { CLOSED: 0, OPEN: 1, LOCKED: 2 } as const;

export type WallKind = "wall" | "door" | "secretDoor" | "limited" | "window";
export type DoorAnimationType = "swing" | "slide" | "swivel" | "ascend" | "descend";

/** Foundry 14 door options. Giving `animation` (or any animation field) writes the animation block. */
export interface DoorOptions {
  animation?: DoorAnimationType;
  double?: boolean;
  flip?: boolean;
  direction?: 1 | -1;
  duration?: number;
  strength?: number;
  locked?: boolean;
  open?: boolean;
}

/**
 * Foundry wall document from a grid-coordinate segment (corners, not squares).
 * `limited` blocks movement but is a Limited sight/light wall: perception passes
 * through one such wall and is stopped by a second. `window` blocks movement only:
 * sight and light pass freely (daylight through glass). It is not Foundry's distance-based
 * "Proximity" wall; make that one with create_embedded if you need it.
 */
export function buildWallFromGrid(
  seg: { x1: number; y1: number; x2: number; y2: number; kind?: WallKind; doorOptions?: DoorOptions },
  gridSize: number,
  origin: { x?: number; y?: number } = {},
): Json {
  const a = gridToPixels(seg.x1, seg.y1, gridSize, origin);
  const b = gridToPixels(seg.x2, seg.y2, gridSize, origin);
  const kind = seg.kind ?? "wall";
  const door = kind === "door" ? WALL_DOOR_TYPES.DOOR : kind === "secretDoor" ? WALL_DOOR_TYPES.SECRET : WALL_DOOR_TYPES.NONE;
  const senses = kind === "limited" ? WALL_SENSE_TYPES.LIMITED : kind === "window" ? WALL_SENSE_TYPES.NONE : WALL_SENSE_TYPES.NORMAL;
  const opts = seg.doorOptions;
  const wall: Json = {
    _id: randomID(),
    c: [a.x, a.y, b.x, b.y],
    door,
    ds: opts?.locked ? WALL_DOOR_STATES.LOCKED : opts?.open ? WALL_DOOR_STATES.OPEN : WALL_DOOR_STATES.CLOSED,
    move: WALL_MOVEMENT_TYPES.NORMAL,
    sight: senses,
    light: senses,
    sound: WALL_SENSE_TYPES.NORMAL,
    dir: 0,
  };
  const animated = opts && (opts.animation || opts.double !== undefined || opts.flip !== undefined || opts.direction !== undefined || opts.duration !== undefined || opts.strength !== undefined);
  if (door !== WALL_DOOR_TYPES.NONE && animated) {
    wall.animation = {
      type: opts.animation ?? "swing",
      direction: opts.direction ?? 1,
      double: opts.double ?? false,
      flip: opts.flip ?? false,
      duration: opts.duration ?? 750,
      strength: opts.strength ?? 1,
    };
  }
  return wall;
}
```

Add after `buildLight`:

```ts
export type LightSource = "torch" | "fireplace" | "candle" | "lantern" | "daylight";

export const LIGHT_PRESETS: Record<LightSource, { bright: number; dim: number; color: string; animation: { type: string | null; speed: number; intensity: number } }> = {
  torch: { bright: 20, dim: 40, color: "#ff9d4a", animation: { type: "torch", speed: 5, intensity: 5 } },
  fireplace: { bright: 15, dim: 30, color: "#ff7a2e", animation: { type: "flame", speed: 4, intensity: 5 } },
  candle: { bright: 5, dim: 15, color: "#ffc36b", animation: { type: "torch", speed: 3, intensity: 2 } },
  lantern: { bright: 15, dim: 30, color: "#ffd9a0", animation: { type: null, speed: 5, intensity: 5 } },
  daylight: { bright: 0, dim: 10, color: "#cfe0ff", animation: { type: null, speed: 5, intensity: 5 } },
};

export interface LightInputLike {
  source?: LightSource;
  bright?: number;
  dim?: number;
  color?: string;
  /** A CONFIG.Canvas.lightAnimations key such as torch, flame, pulse. */
  animation?: string;
}

/** Preset first, explicit values on top. */
export function resolveLightInput(l: LightInputLike): { bright: number; dim: number; color: string | null; animation: { type: string | null; speed: number; intensity: number } } {
  const preset = l.source ? LIGHT_PRESETS[l.source] : undefined;
  return {
    bright: l.bright ?? preset?.bright ?? 0,
    dim: l.dim ?? preset?.dim ?? 0,
    color: l.color ?? preset?.color ?? null,
    animation: { ...(preset?.animation ?? { type: null, speed: 5, intensity: 5 }), ...(l.animation ? { type: l.animation } : {}) },
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/shared/src/scene-builders.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tool-level test**

Append to `test/integration/scene-tools.test.ts` (reuse that file's existing `setup`/scene seeding helpers; read the top of the file first and follow its pattern for a square scene):

```ts
describe("add_walls and add_lights: windows, door animation, light animation", () => {
  it("add_walls writes a window, an animated door and a locked door", async () => {
    const { mock, transport, sceneId } = await setupSquareScene();
    const out = await runAddWalls(transport, {
      sceneId,
      walls: [
        { x1: 0, y1: 0, x2: 2, y2: 0, kind: "window" },
        { x1: 2, y1: 0, x2: 3, y2: 0, kind: "door", animation: "slide", double: false },
        { x1: 3, y1: 0, x2: 4, y2: 0, kind: "door", locked: true },
      ],
    });
    expect(out.ok).toBe(true);
    const walls = (mock.store.get(`!scenes!${sceneId}`) as any).walls;
    expect(walls[0]).toMatchObject({ sight: 0, light: 0, move: 20 });
    expect(walls[1].animation).toMatchObject({ type: "slide" });
    expect(walls[2]).toMatchObject({ ds: 2 });
  });

  it("add_lights takes a source preset and an animation override", async () => {
    const { mock, transport, sceneId } = await setupSquareScene();
    const out = await runAddLights(transport, {
      sceneId,
      lights: [{ col: 1.5, row: 1.5, source: "fireplace" }, { col: 3.5, row: 1.5, bright: 10, animation: "pulse" }],
    });
    expect(out.ok).toBe(true);
    const lights = (mock.store.get(`!scenes!${sceneId}`) as any).lights;
    expect(lights[0].config).toMatchObject({ bright: 15, dim: 30, color: "#ff7a2e", animation: { type: "flame" } });
    expect(lights[1].config.animation.type).toBe("pulse");
  });
});
```

(`setupSquareScene` stands for the file's existing helper that creates a square scene and returns `{ mock, transport, sceneId }`; if the file names it differently, use that name.)

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/integration/scene-tools.test.ts`
Expected: FAIL (zod rejects `window`, `animation`, `source`).

- [ ] **Step 7: Implement in `scene-tools.ts`**

In `AddWallsShape` change the `kind` enum and add the door fields:

```ts
        kind: z.enum(["wall", "door", "secretDoor", "limited", "window"]).optional().describe("limited = blocks movement, Limited sight/light (see through one, blocked by two). window = blocks movement only, sight and light pass (glass). Not Foundry's distance-based Proximity wall; make that with create_embedded."),
        animation: z.enum(["swing", "slide", "swivel", "ascend", "descend"]).optional().describe("Foundry 14 door animation (doors only)"),
        double: z.boolean().optional().describe("Double door (doors only)"),
        flip: z.boolean().optional(),
        locked: z.boolean().optional().describe("Door starts locked"),
        open: z.boolean().optional().describe("Door starts open"),
```

and in `runAddWalls` replace the map callback:

```ts
  const data = args.walls.map(({ animation, double, flip, locked, open, ...seg }) =>
    buildWallFromGrid({ ...seg, doorOptions: { animation, double, flip, locked, open } }, gridResult.size, gridResult.origin),
  );
```

In `AddLightsShape` add:

```ts
        source: z.enum(["torch", "fireplace", "candle", "lantern", "daylight"]).optional().describe("Preset: radii, colour and animation; explicit fields override it"),
        animation: z.string().optional().describe("Foundry light animation key, e.g. torch, flame, pulse"),
```

and in `runAddLights` replace the map callback body's `buildLight` call:

```ts
    const { x, y } = gridToPixels(light.col, light.row, gridResult.size, gridResult.origin);
    const r = resolveLightInput(light);
    return buildLight({ x, y, bright: r.bright, dim: r.dim, color: r.color, animation: r.animation });
```

Import `resolveLightInput` from `@foundry-mcp-bridge/shared` alongside the existing builders. Update the two tool descriptions in `server.ts` (`add_walls`: mention `window` and `animation`; `add_lights`: mention `source` and `animation`).

- [ ] **Step 8: Run everything**

Run: `npm run typecheck && npm test`
Expected: all pass (existing wall/light tests unchanged).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/scene-builders.ts packages/shared/src/scene-builders.test.ts packages/mcp-server/src/scene-tools.ts packages/mcp-server/src/server.ts test/integration/scene-tools.test.ts
git commit -m "add_walls: windows and door animation; add_lights: presets and animation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Floorplan spec schema and room validation (and the spec edit)

**Files:**
- Create: `packages/shared/src/floorplan.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./floorplan.js";`)
- Modify: `docs/superpowers/specs/2026-10-12-floorplan-scene-design.md` (window = see-through wall with `sight`/`light` NONE, no threshold; `exterior` and `state` replaced by derived exteriority and `open`; light `at` is a cell, the light sits at its centre)
- Test: `packages/shared/src/floorplan.test.ts`

**Interfaces:**
- Produces: `FloorplanSchema`, `type Floorplan` (parsed), `type FloorplanInput`, `type Room`, `type Opening`, `LIGHT_SOURCES`, `DOOR_ANIMATIONS`, `validateFloorplan(plan: Floorplan): string[]` (empty = valid). Task 3 adds `buildGeometry` to the same file.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/shared/src/floorplan.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `floorplan.ts`**

```ts
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
```

Add `export * from "./floorplan.js";` to `packages/shared/src/index.ts`.

Edit the spec as listed in **Files** (three small edits: the "Door and window defaults" window bullet, the input-spec `openings` line, the light `at` note).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/shared/src/floorplan.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/floorplan.ts packages/shared/src/floorplan.test.ts packages/shared/src/index.ts docs/superpowers/specs/2026-10-12-floorplan-scene-design.md
git commit -m "Floorplan spec schema and validation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Geometry: walls and lights from the spec

**Files:**
- Modify: `packages/shared/src/floorplan.ts` (append)
- Test: `packages/shared/src/floorplan.test.ts` (append)

**Interfaces:**
- Consumes: `Floorplan`, `Room`, `Opening`, `sideLength`, `validateFloorplan` from Task 2; `WallKind`, `DoorOptions`, `resolveLightInput` from Task 1 (import from `./scene-builders.js`).
- Produces:
  - `interface WallSegment { x1: number; y1: number; x2: number; y2: number; kind: WallKind; doorOptions?: DoorOptions }` (grid corner coordinates, directly usable by `buildWallFromGrid`)
  - `interface PlacedLight { col: number; row: number; source: LightSource; bright: number; dim: number; color: string | null; animation: { type: string | null; speed: number; intensity: number } }` (col/row include the +0.5 cell centre)
  - `buildGeometry(plan: Floorplan): { ok: true; walls: WallSegment[]; lights: PlacedLight[] } | { ok: false; errors: string[] }` (runs `validateFloorplan` first)

- [ ] **Step 1: Write the failing tests**

```ts
import { buildGeometry } from "./floorplan.js";

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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/shared/src/floorplan.test.ts`
Expected: FAIL (`buildGeometry` not exported).

- [ ] **Step 3: Implement (append to `floorplan.ts`)**

```ts
import { resolveLightInput, type DoorOptions, type LightSource, type WallKind } from "./scene-builders.js";

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

export function buildGeometry(
  plan: Floorplan,
): { ok: true; walls: WallSegment[]; lights: PlacedLight[] } | { ok: false; errors: string[] } {
  const errors = validateFloorplan(plan);
  if (errors.length) return { ok: false, errors };

  const rooms = new Map(plan.rooms.map((r) => [r.id, r]));
  const roomsPerEdge = new Map<string, number>();
  const edges = new Map<string, Edge>();
  for (const r of plan.rooms) {
    for (const e of roomEdges(r)) {
      const k = edgeKey(e);
      roomsPerEdge.set(k, (roomsPerEdge.get(k) ?? 0) + 1);
      edges.set(k, e);
    }
  }

  const walls: WallSegment[] = [];
  const claimed = new Map<string, number>();
  let exteriorDoors = 0;
  plan.openings.forEach((o, i) => {
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
      seg.doorOptions = { animation: o.animation ?? "swing", double: o.double ?? o.width >= 2, flip: o.flip, locked: o.locked, open: o.open };
      if (es.every((e) => roomsPerEdge.get(edgeKey(e)) === 1)) exteriorDoors++;
    }
    walls.push(seg);
  });
  if (exteriorDoors === 0) errors.push("the house has no exterior door");
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

  const lights: PlacedLight[] = plan.lights.map((l) => ({ col: l.at[0] + 0.5, row: l.at[1] + 0.5, source: l.source, ...resolveLightInput(l) }));
  return { ok: true, walls, lights };
}
```


- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/shared/src/floorplan.test.ts && npm run typecheck`
Expected: PASS. If the first test's `toEqual` on `doorOptions` fails on `undefined` keys, switch that assertion to `toMatchObject` with only the defined fields; the behaviour is right either way.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/floorplan.ts packages/shared/src/floorplan.test.ts
git commit -m "Floorplan geometry: walls, doors, windows and lights from the room spec

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Guide and overlay renderers (PNG, no dependencies)

**Files:**
- Create: `packages/mcp-server/src/floorplan-render.ts`
- Test: `test/unit/floorplan-render.test.ts` (use `test/integration/generate-image.test.ts` imports as the model for importing from `packages/mcp-server/src`)

**Interfaces:**
- Consumes: `Floorplan`, `buildGeometry`, `WallSegment`, `PlacedLight` (shared).
- Produces: `class Raster { constructor(width: number, height: number); fillRect(x, y, w, h, rgba: [number, number, number, number]): void; fillCircle(cx, cy, r, rgba): void; pixel(x, y): [number, number, number, number]; toPng(): Buffer }`, `renderGuide(plan: Floorplan, walls: WallSegment[]): Buffer`, `renderOverlay(plan: Floorplan, walls: WallSegment[], lights: PlacedLight[]): Buffer`, `readPngSize(bytes): { width, height } | null` (re-export `pngSize` from `image-gen.ts` instead of duplicating).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { FloorplanSchema, buildGeometry } from "../../packages/shared/src/index.js";
import { Raster, renderGuide, renderOverlay } from "../../packages/mcp-server/src/floorplan-render.js";
import { pngSize } from "../../packages/mcp-server/src/image-gen.js";

const plan = FloorplanSchema.parse({
  name: "T", cols: 8, rows: 6, pxPerCell: 50,
  rooms: [{ id: "a", x: 1, y: 1, w: 6, h: 4 }],
  openings: [{ room: "a", side: "s", at: 2, kind: "door" }, { room: "a", side: "n", at: 1, width: 2, kind: "window" }],
  lights: [{ at: [2, 2], source: "torch" }],
});
const geometry = (() => { const g = buildGeometry(plan); if (!g.ok) throw new Error(g.errors.join()); return g; })();

/** Decode our own RGBA PNG back to pixels (the tests only ever read PNGs this module wrote). */
function decode(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let idat = Buffer.alloc(0);
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    if (png.toString("ascii", o + 4, o + 8) === "IDAT") idat = Buffer.concat([idat, png.subarray(o + 8, o + 8 + len)]);
    o += 12 + len;
  }
  const raw = inflateSync(idat);
  const px = (x: number, y: number) => { const i = y * (1 + width * 4) + 1 + x * 4; return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]; };
  return { width, height, px };
}

describe("Raster", () => {
  it("writes a valid PNG of the right size", () => {
    const r = new Raster(10, 4);
    r.fillRect(0, 0, 10, 4, [1, 2, 3, 255]);
    expect(pngSize(r.toPng())).toEqual({ width: 10, height: 4 });
  });
  it("clips drawing at the edges", () => {
    const r = new Raster(4, 4);
    expect(() => r.fillRect(-5, -5, 20, 20, [9, 9, 9, 255])).not.toThrow();
    expect(r.pixel(3, 3)).toEqual([9, 9, 9, 255]);
  });
});

describe("renderGuide", () => {
  const img = decode(renderGuide(plan, geometry.walls));
  it("is exactly cols x rows cells", () => {
    expect([img.width, img.height]).toEqual([400, 300]);
  });
  it("paints the outside, the floor and the wall differently", () => {
    const outside = img.px(10, 10);
    const floor = img.px(200, 150);
    const wall = img.px(60, 50); // on the north wall line y=1 cell => 50px
    expect(new Set([outside.join(), floor.join(), wall.join()]).size).toBe(3);
  });
  it("draws the doorway differently from the wall around it", () => {
    const door = img.px(125, 250); // south wall (y=5 cells => 250px), door at cells 3..4 => x 150..200? at=2 => x=(1+2)*50=150..200
    const wall = img.px(60, 250);
    expect(door.join()).not.toBe(wall.join());
  });
});

describe("renderOverlay", () => {
  const img = decode(renderOverlay(plan, geometry.walls, geometry.lights));
  it("is transparent where nothing is drawn", () => {
    expect(img.px(5, 5)[3]).toBe(0);
  });
  it("marks a wall, a window and a light", () => {
    expect(img.px(60, 250)[3]).toBeGreaterThan(0); // plain south wall
    expect(img.px(100, 50)[3]).toBeGreaterThan(0); // window on the north wall
    expect(img.px(125, 125)[3]).toBeGreaterThan(0); // torch at cell [2,2] => centre (2.5*50, 2.5*50)
  });
});
```

Fix the pixel coordinates in the door assertion while writing it: the south wall is at `y = (1 + 4) * 50 = 250` and the door covers `x = (1 + 2) * 50 = 150` to `200`, so sample `img.px(175, 250)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/floorplan-render.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `floorplan-render.ts`**

```ts
/**
 * Pure PNG drawing for the floorplan tool: the blueprint guide Codex paints over, and the
 * overlay that shows where Foundry's walls and lights will sit. No image dependency.
 */

import { deflateSync } from "node:zlib";
import type { Floorplan, PlacedLight, WallSegment } from "@foundry-mcp-bridge/shared";

type Rgba = [number, number, number, number];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

export class Raster {
  private readonly data: Uint8Array;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(width * height * 4);
  }
  pixel(x: number, y: number): Rgba {
    const i = (y * this.width + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }
  fillRect(x: number, y: number, w: number, h: number, c: Rgba): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.data.set(c, (py * this.width + px) * 4);
  }
  fillCircle(cx: number, cy: number, r: number, c: Rgba): void {
    for (let py = Math.max(0, Math.floor(cy - r)); py <= Math.min(this.height - 1, Math.ceil(cy + r)); py++)
      for (let px = Math.max(0, Math.floor(cx - r)); px <= Math.min(this.width - 1, Math.ceil(cx + r)); px++)
        if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) this.data.set(c, (py * this.width + px) * 4);
  }
  toPng(): Buffer {
    const row = 1 + this.width * 4;
    const raw = Buffer.alloc(row * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * row] = 0;
      Buffer.from(this.data.buffer, this.data.byteOffset + y * this.width * 4, this.width * 4).copy(raw, y * row + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8;
    header[9] = 6; // RGBA
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  }
}

/** A thick axis-aligned line centred on the segment, in pixels. */
function drawSegment(r: Raster, seg: WallSegment, px: number, thickness: number, c: Rgba): void {
  const x1 = seg.x1 * px;
  const y1 = seg.y1 * px;
  const x2 = seg.x2 * px;
  const y2 = seg.y2 * px;
  const half = thickness / 2;
  if (y1 === y2) r.fillRect(Math.min(x1, x2) - half, y1 - half, Math.abs(x2 - x1) + thickness, thickness, c);
  else r.fillRect(x1 - half, Math.min(y1, y2) - half, thickness, Math.abs(y2 - y1) + thickness, c);
}

const OUTSIDE: Rgba = [96, 112, 84, 255];
const WALL: Rgba = [43, 33, 24, 255];
const DOOR: Rgba = [139, 90, 43, 255];
const SECRET: Rgba = [43, 33, 24, 255];
const WINDOW: Rgba = [150, 200, 230, 255];
const FLOORS: Rgba[] = [[217, 201, 168, 255], [201, 190, 170, 255], [208, 186, 160, 255], [196, 200, 176, 255]];

/** Blueprint: exact room rectangles, walls, doors and windows at pxPerCell. Codex paints over it. */
export function renderGuide(plan: Floorplan, walls: WallSegment[]): Buffer {
  const px = plan.pxPerCell;
  const r = new Raster(plan.cols * px, plan.rows * px);
  r.fillRect(0, 0, r.width, r.height, OUTSIDE);
  plan.rooms.forEach((room, i) => r.fillRect(room.x * px, room.y * px, room.w * px, room.h * px, FLOORS[i % FLOORS.length]!));
  const t = Math.max(4, Math.round(px * 0.12));
  for (const w of walls) {
    const colour = w.kind === "door" ? DOOR : w.kind === "secretDoor" ? SECRET : w.kind === "window" ? WINDOW : WALL;
    drawSegment(r, w, px, t, colour);
  }
  return r.toPng();
}

const OV_WALL: Rgba = [255, 40, 40, 255];
const OV_DOOR: Rgba = [40, 220, 80, 255];
const OV_WINDOW: Rgba = [40, 200, 255, 255];
const OV_LIGHT: Rgba = [255, 230, 40, 255];

/** Transparent overlay: red walls, green doors, cyan windows, yellow lights. */
export function renderOverlay(plan: Floorplan, walls: WallSegment[], lights: PlacedLight[]): Buffer {
  const px = plan.pxPerCell;
  const r = new Raster(plan.cols * px, plan.rows * px);
  for (const w of walls) {
    const colour = w.kind === "door" || w.kind === "secretDoor" ? OV_DOOR : w.kind === "window" ? OV_WINDOW : OV_WALL;
    drawSegment(r, w, px, 6, colour);
  }
  for (const l of lights) r.fillCircle(l.col * px, l.row * px, Math.max(6, px * 0.12), OV_LIGHT);
  return r.toPng();
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/unit/floorplan-render.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Add the image helpers (`fitImage`, `compositePreview`) with a test**

Append to `floorplan-render.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

/** True when ImageMagick's `magick` is on PATH. */
export async function hasMagick(): Promise<boolean> {
  try {
    await run("magick", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Resize `file` in place to exactly width x height (non-uniform: walls must land on the grid). */
export async function fitImage(file: string, width: number, height: number): Promise<void> {
  await run("magick", [file, "-resize", `${width}x${height}!`, file]);
}

/** Overlay on top of the picture as a PNG for a quick visual check. */
export async function compositePreview(picture: string, overlayPng: string, out: string): Promise<void> {
  await run("magick", [picture, overlayPng, "-compose", "over", "-composite", out]);
}
```

Test (in the same unit test file, skipped when `magick` is absent):

```ts
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitImage, hasMagick } from "../../packages/mcp-server/src/floorplan-render.js";

describe("fitImage", async () => {
  const magick = await hasMagick();
  it.skipIf(!magick)("resizes to exactly the requested size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-"));
    const file = join(dir, "a.png");
    writeFileSync(file, renderGuide(plan, geometry.walls));
    await fitImage(file, 160, 120);
    expect(pngSize(readFileSync(file))).toEqual({ width: 160, height: 120 });
  });
});
```

Run: `npx vitest run test/unit/floorplan-render.test.ts` (expected PASS on a machine with ImageMagick), then commit:

```bash
git add packages/mcp-server/src/floorplan-render.ts test/unit/floorplan-render.test.ts
git commit -m "Floorplan renderers: blueprint guide, alignment overlay, fit and preview helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Attach a guide image to the Codex run

**Files:**
- Modify: `packages/mcp-server/src/image-gen.ts` (`ImageRequest`, `buildGenImageArgs`)
- Modify: `scripts/gen-image.mjs` (`backendCodex`)
- Test: `test/integration/generate-image.test.ts` (near the existing `buildGenImageArgs` test), `test/unit/gen-image.test.mjs`

**Interfaces:**
- Produces: `ImageRequest.guidePath?: string`; `buildGenImageArgs` appends `--image <guidePath>` when set (and nothing else changes when unset); `gen-image.mjs --image <file>` runs `codex exec ... -i <file> -- <prompt>`.

- [ ] **Step 1: Confirm the argument order against the real Codex CLI** (the one thing the spec marks as a risk)

Run (replace the path with any small PNG, e.g. one written by `renderGuide` in a scratch script):

```bash
codex exec --skip-git-repo-check -s read-only -i /path/to/guide.png -- "Describe this image in one sentence."
```
Expected: Codex answers about the image. If `-i ... --` is rejected, try `codex exec ... "Describe this image." -i /path/to/guide.png`; if only that form works, use it in Step 4 and keep Step 3's test in sync. If Codex cannot see images at all, stop and report: the spec's fallback (prompt-only) is then the design and Tasks 5 to 6 drop the guide.

- [ ] **Step 2: Write the failing tests**

In `test/integration/generate-image.test.ts` after the existing `buildGenImageArgs` test:

```ts
  it("passes the guide image to gen-image", () => {
    const args = buildGenImageArgs({ prompt: "p", width: 10, height: 20, outPath: "/o/x.webp", guidePath: "/g/guide.png" }, "/s/gen-image.mjs");
    expect(args).toEqual(["/s/gen-image.mjs", "--backend", "codex", "--prompt", "p", "--out", "/o/x.webp", "--width", "10", "--height", "20", "--no-sidecar", "--image", "/g/guide.png"]);
  });
```

In `test/unit/gen-image.test.mjs` (read it first; it imports helpers from `scripts/gen-image.mjs`), add a test for a new exported pure helper `buildCodexArgv(args, model)`:

```js
import { buildCodexArgv } from "../../scripts/gen-image.mjs";

test("buildCodexArgv attaches the guide before the prompt", () => {
  const argv = buildCodexArgv({ prompt: "paint it", image: "/g/guide.png" }, undefined);
  const i = argv.indexOf("-i");
  expect(argv.slice(i, i + 3)).toEqual(["-i", "/g/guide.png", "--"]);
  expect(argv.at(-1)).toContain("paint it");
});

test("buildCodexArgv without a guide is unchanged", () => {
  const argv = buildCodexArgv({ prompt: "paint it" }, "m1");
  expect(argv).not.toContain("-i");
  expect(argv.slice(0, 5)).toEqual(["exec", "--json", "-s", "read-only", "--skip-git-repo-check"]);
  expect(argv).toContain("m1");
});
```

(Use the file's existing assertion style if it is `node:test` rather than vitest.)

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/integration/generate-image.test.ts test/unit/gen-image.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Implement**

`image-gen.ts`: add to `ImageRequest`:

```ts
  /** A local image Codex is shown alongside the prompt (a blueprint to paint over). */
  guidePath?: string;
```

and in `buildGenImageArgs` before the model line:

```ts
    ...(request.guidePath ? ["--image", request.guidePath] : []),
```

`gen-image.mjs`: extract and export the argv builder, then use it in `backendCodex`:

```js
export function buildCodexArgv(args, model) {
  const argv = ["exec", "--json", "-s", "read-only", "--skip-git-repo-check"];
  if (model) argv.push("-m", model);
  if (args.image) argv.push("-i", args.image, "--");
  argv.push(buildCodexPrompt(args));
  return argv;
}
```

In `backendCodex` replace the four lines that build `argv` with `const argv = buildCodexArgv(args, model);`.

- [ ] **Step 5: Run to verify they pass, then commit**

Run: `npm run typecheck && npm test`
Expected: PASS

```bash
git add packages/mcp-server/src/image-gen.ts scripts/gen-image.mjs test/integration/generate-image.test.ts test/unit/gen-image.test.mjs
git commit -m "Image jobs can attach a guide image to the Codex run

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The `build_floorplan_scene` tool

**Files:**
- Create: `packages/mcp-server/src/floorplan-finish.ts` (everything after the picture exists: fit, upload, scene, walls, lights, preview)
- Create: `packages/mcp-server/src/floorplan-tools.ts` (the tool: validate, guide, start the job)
- Modify: `packages/mcp-server/src/image-tools.ts` (`ImageApply` gains the internal `FloorplanApply`; `followUp` delegates to `finishFloorplan`)
- Modify: `packages/mcp-server/src/floorplan-render.ts` (add `imageSize`)
- Modify: `packages/mcp-server/src/server.ts` (register), `README.md` (tool list)
- Test: `test/integration/floorplan-tool.test.ts`

`floorplan-finish.ts` must not import `image-tools.ts` (that file imports it); it imports only from `tools.ts`, `scene-tools.ts`, `floorplan-render.ts` and shared.

**Interfaces:**
- Consumes: `FloorplanSchema`, `buildGeometry`, `Floorplan`, `WallSegment`, `PlacedLight` (shared; `PlacedLight` carries `source`, see Task 3); `renderGuide`, `renderOverlay`, `hasMagick`, `fitImage`, `compositePreview` (Task 4); `ImageRequest.guidePath` (Task 5); existing `runUploadAsset`, `runCreateScene`, `runGetWorldInfo`, `showImageFilename` (`tools.ts`), `runAddWalls`, `runAddLights` (`scene-tools.ts`), `ImageJobRegistry`.
- Produces: `FloorplanDeps`, `realFloorplanDeps`, `FloorplanApply`, `finishFloorplan`, `FloorplanSceneShape`, `buildFloorplanPrompt`, `runBuildFloorplanScene`.

- [ ] **Step 1: Add `imageSize` to `floorplan-render.ts`** (and a test next to the `fitImage` one, skipped without magick)

```ts
/** Pixel size of any image ImageMagick can read (the picture may be a webp: no PNG header to parse). */
export async function imageSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await run("magick", ["identify", "-format", "%w %h", file]);
    const [w, h] = stdout.trim().split(" ").map(Number);
    return w && h ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}
```

```ts
  it.skipIf(!magick)("reads the size of a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "size-"));
    const file = join(dir, "a.png");
    writeFileSync(file, renderGuide(plan, geometry.walls));
    expect(await imageSize(file)).toEqual({ width: 400, height: 300 });
  });
```

- [ ] **Step 2: Write the failing tests** (`test/integration/floorplan-tool.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { ChangeLog } from "../../packages/mcp-server/src/change-log.js";
import { runUndoChange } from "../../packages/mcp-server/src/change-tools.js";
import { ImageJobs, type ImageRequest, type ImageRunner } from "../../packages/mcp-server/src/image-gen.js";
import { runBuildFloorplanScene } from "../../packages/mcp-server/src/floorplan-tools.js";
import { runCheckImageJob, type ImageJobMeta } from "../../packages/mcp-server/src/image-tools.js";
import type { FloorplanDeps } from "../../packages/mcp-server/src/floorplan-finish.js";

const house = {
  name: "Cottage", cols: 16, rows: 10, pxPerCell: 50,
  rooms: [
    { id: "hall", x: 1, y: 1, w: 8, h: 8, furnishings: ["long table", "fireplace"] },
    { id: "kitchen", x: 9, y: 1, w: 6, h: 4, furnishings: ["stove", "barrels"] },
    { id: "bedroom", x: 9, y: 5, w: 6, h: 4, furnishings: ["bed", "chest"] },
  ],
  openings: [
    { room: "hall", side: "w", at: 3, kind: "door", locked: true },
    { room: "hall", side: "e", at: 1, kind: "door", animation: "slide" },
    { room: "hall", side: "e", at: 5, kind: "door" },
    { room: "kitchen", side: "n", at: 2, width: 2, kind: "window" },
    { room: "bedroom", side: "s", at: 2, kind: "window" },
  ],
  lights: [{ at: [2, 4], source: "fireplace" }, { at: [10, 2], source: "torch" }],
} as const;

const dir = () => mkdtempSync(join(tmpdir(), "floorplan-"));

async function setup(opts: { foundryVersion?: string; pictureSize?: [number, number]; magick?: boolean } = {}) {
  const mock = new MockFoundry({ worldInfo: { foundryVersion: opts.foundryVersion ?? "14.368" } });
  const transport = new MockTransport(mock);
  const requests: ImageRequest[] = [];
  const runner: ImageRunner = async (request) => {
    requests.push(request);
    await mkdir(dirname(request.outPath), { recursive: true });
    await writeFile(request.outPath, Buffer.from("fake picture"));
    return { path: request.outPath };
  };
  const jobs = new ImageJobs<ImageJobMeta>(runner);
  const fits: Array<[number, number]> = [];
  const deps: FloorplanDeps = {
    hasMagick: async () => opts.magick ?? true,
    imageSize: async () => ({ width: opts.pictureSize?.[0] ?? 800, height: opts.pictureSize?.[1] ?? 500 }),
    fitImage: async (_f, w, h) => void fits.push([w, h]),
    compositePreview: async () => {},
  };
  const outputDir = dir();
  const log = new ChangeLog(join(dir(), "changes.jsonl"));
  const callOpts = (tool: string) => ({ changes: { log, requestId: `req-${tool}`, tool, warnings: [] as string[] } });
  const run = async (plan: unknown) => {
    const first = await runBuildFloorplanScene(jobs, outputDir, transport, { ...(plan as object), waitSeconds: 5 } as never, callOpts("build_floorplan_scene"), deps);
    if (first.ok && (first.data as any).status === "running") {
      return runCheckImageJob(jobs, transport, { jobId: (first.data as any).jobId, waitSeconds: 5 }, callOpts("build_floorplan_scene"));
    }
    return first;
  };
  return { mock, transport, requests, fits, run, log, callOpts, outputDir };
}

const onlyScene = (mock: MockFoundry) => [...mock.store.entries()].find(([k]) => k.startsWith("!scenes!"))![1] as any;

describe("build_floorplan_scene", () => {
  it("builds the scene, walls, doors, windows and lights in one call", async () => {
    const t = await setup();
    const out = await t.run(house);
    expect(out.ok).toBe(true);
    const scene = onlyScene(t.mock);
    expect(scene).toMatchObject({ width: 800, height: 500, grid: { size: 50, distance: 5 } });
    const doors = scene.walls.filter((w: any) => w.door === 1);
    expect(doors).toHaveLength(3);
    expect(doors.map((d: any) => d.animation.type).sort()).toEqual(["slide", "swing", "swing"]);
    expect(doors.some((d: any) => d.ds === 2)).toBe(true);
    expect(scene.walls.filter((w: any) => w.sight === 0 && w.light === 0)).toHaveLength(2);
    expect(scene.lights.map((l: any) => l.config.animation.type).sort()).toEqual(["flame", "torch"]);
    expect(t.requests[0]!.guidePath).toMatch(/guide-.*cottage.*\.png$/);
    expect(t.requests[0]!.outPath).toMatch(/floorplan-.*cottage.*\.webp$/);
    expect(t.requests[0]!.prompt).toContain("long table");
  });

  it("uploads the picture as image/webp", async () => {
    const t = await setup();
    await t.run(house);
    expect(t.mock.filePicker.uploads[0]).toMatchObject({ mimeType: "image/webp" });
    expect(t.mock.filePicker.uploads[0]!.filename).toMatch(/\.webp$/);
  });

  it("rejects a bad layout before starting Codex", async () => {
    const t = await setup();
    const out = await t.run({ ...house, openings: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("VALIDATION");
      expect(out.error.message).toContain("no exterior door");
    }
    expect(t.requests).toHaveLength(0);
  });

  it("refuses animated doors on Foundry 13", async () => {
    const t = await setup({ foundryVersion: "13.351" });
    const out = await t.run(house);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("UNSUPPORTED");
    expect(t.requests).toHaveLength(0);
  });

  it("resizes a picture of the wrong size and says so", async () => {
    const t = await setup({ pictureSize: [1536, 1024] });
    const out = await t.run(house);
    expect(out.ok).toBe(true);
    expect(t.fits).toEqual([[800, 500]]);
    if (out.ok) expect((out.data as any).warnings.join(" ")).toContain("resized");
  });

  it("does not resize a picture that already has the right size", async () => {
    const t = await setup();
    await t.run(house);
    expect(t.fits).toEqual([]);
  });

  it("still builds the scene and returns the overlay file when ImageMagick is missing", async () => {
    const t = await setup({ magick: false });
    const out = await t.run(house);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data as any).overlay).toMatch(/overlay-.*cottage.*\.png$/);
      expect((out.data as any).warnings.join(" ")).toContain("ImageMagick");
    }
    expect(onlyScene(t.mock).walls.length).toBeGreaterThan(0);
  });

  it("codex:false uses the blueprint itself and starts no Codex job", async () => {
    const t = await setup();
    const out = await t.run({ ...house, codex: false });
    expect(out.ok).toBe(true);
    expect(t.requests).toHaveLength(0);
    expect(onlyScene(t.mock).walls.length).toBeGreaterThan(0);
  });

  it("is undone by requestId: scene, walls and lights go together", async () => {
    const t = await setup();
    await t.run(house);
    expect([...t.mock.store.keys()].some((k) => k.startsWith("!scenes!"))).toBe(true);
    const undone = await runUndoChange(t.log, t.transport, { requestId: "req-build_floorplan_scene" }, t.callOpts("undo_change"));
    expect(undone.ok).toBe(true);
    expect([...t.mock.store.keys()].some((k) => k.startsWith("!scenes!"))).toBe(false);
  });
});
```

(`ChangeLog`'s constructor and `runUndoChange` import path: copy them exactly from `test/integration/change-log-permissions.test.ts`'s `setup()`; the lines above follow that file but check the names when typing them in. `ImageJobs<ImageJobMeta>` construction: copy from `generate-image.test.ts`.)

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/integration/floorplan-tool.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `floorplan-finish.ts`**

```ts
/**
 * Everything after the picture exists: fit it to the grid, upload it, create the scene, then the
 * walls and the lights. Walls and lights go through add_walls / add_lights, which already read the
 * grid origin Foundry applied and write read-back-verified, logged, undoable embedded documents.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Floorplan, PlacedLight, WallSegment } from "@foundry-mcp-bridge/shared";
import type { PipelineOptions, ToolOutcome } from "./reliability.js";
import type { RelayTransport } from "./relay-transport.js";
import { runCreateScene, runUploadAsset, showImageFilename } from "./tools.js";
import { runAddLights, runAddWalls } from "./scene-tools.js";
import { compositePreview, fitImage, hasMagick, imageSize } from "./floorplan-render.js";

export interface FloorplanDeps {
  hasMagick: () => Promise<boolean>;
  imageSize: (file: string) => Promise<{ width: number; height: number } | null>;
  fitImage: (file: string, width: number, height: number) => Promise<void>;
  compositePreview: (picture: string, overlayPng: string, out: string) => Promise<void>;
}
export const realFloorplanDeps: FloorplanDeps = { hasMagick, imageSize, fitImage, compositePreview };

/** What an image job carries to turn the finished picture into a scene. */
export interface FloorplanApply {
  to: "floorplanScene";
  plan: Floorplan;
  walls: WallSegment[];
  lights: PlacedLight[];
  overlayPath: string;
}

const fail = (code: "VALIDATION" | "INTERNAL" | "UNSUPPORTED", message: string, steps: string[]): ToolOutcome => ({ ok: false, error: { code, message }, steps });

export async function finishFloorplan(
  input: { file: string; apply: FloorplanApply; source: "data" | "forgevtt"; target: string; deps?: FloorplanDeps },
  transport: RelayTransport,
  opts: PipelineOptions,
): Promise<ToolOutcome> {
  const { file, apply, source, target } = input;
  const deps = input.deps ?? realFloorplanDeps;
  const { plan } = apply;
  const width = plan.cols * plan.pxPerCell;
  const height = plan.rows * plan.pxPerCell;
  const steps = ["generate"];
  const warnings: string[] = [];

  const magick = await deps.hasMagick();
  if (magick) {
    const before = await deps.imageSize(file);
    if (before && (before.width !== width || before.height !== height)) {
      await deps.fitImage(file, width, height);
      warnings.push(`the picture was ${before.width}x${before.height} and was resized to ${width}x${height} so the walls land on the grid`);
      steps.push("fit");
    }
  } else {
    warnings.push("ImageMagick (magick) was not found: the picture was not checked or resized, and no preview was made; if its size is not " + `${width}x${height} the walls will not line up`);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (e) {
    return fail("INTERNAL", `Cannot read the picture ${file}: ${(e as Error).message}`, steps);
  }
  const ext = extname(file).toLowerCase() === ".webp" ? ".webp" : ".png";
  steps.push("upload");
  const uploaded = await runUploadAsset(
    transport,
    { source, target, filename: `floorplan-${showImageFilename(plan.name, ext)}`, contentBase64: bytes.toString("base64"), mimeType: ext === ".webp" ? "image/webp" : "image/png" },
    opts,
  );
  if (!uploaded.ok) return { ...uploaded, steps: [...steps, ...uploaded.steps] };
  const src = (uploaded.data as { path: string }).path;

  steps.push("scene");
  const scene = await runCreateScene(transport, { name: plan.name, width, height, gridSize: plan.pxPerCell, gridDistance: plan.feetPerCell, background: src } as never, opts);
  if (!scene.ok) return { ...scene, steps: [...steps, ...scene.steps] };
  const sceneId = (scene.data as { _id: string })._id;

  steps.push("walls");
  const walls = await runAddWalls(
    transport,
    { sceneId, walls: apply.walls.map((w) => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, kind: w.kind, ...w.doorOptions })) } as never,
    opts,
  );
  if (!walls.ok) return { ...walls, steps: [...steps, ...walls.steps] };

  if (apply.lights.length) {
    steps.push("lights");
    const lights = await runAddLights(
      transport,
      { sceneId, lights: apply.lights.map((l) => ({ col: l.col, row: l.row, source: l.source, bright: l.bright, dim: l.dim, color: l.color ?? undefined, animation: l.animation.type ?? undefined })) } as never,
      opts,
    );
    if (!lights.ok) return { ...lights, steps: [...steps, ...lights.steps] };
  }

  let preview: string | undefined;
  if (magick) {
    preview = apply.overlayPath.replace(/overlay-/, "preview-");
    try {
      await deps.compositePreview(file, apply.overlayPath, preview);
      steps.push("preview");
    } catch (e) {
      preview = undefined;
      warnings.push(`the alignment preview could not be made: ${(e as Error).message}`);
    }
  }

  return {
    ok: true,
    data: { sceneId, src, file, overlay: apply.overlayPath, ...(preview ? { preview } : {}), walls: apply.walls.length, lights: apply.lights.length, warnings },
    steps,
  };
}
```

(`PlacedLight` needs `source: LightSource`: add it in Task 3's interface and its `buildGeometry` mapping `{ col, row, source: l.source, ...resolveLightInput(l) }`, and put `source: "fireplace"` into that task's `toEqual` expectation.)

- [ ] **Step 5: Implement `floorplan-tools.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FloorplanSchema, buildGeometry, type Floorplan } from "@foundry-mcp-bridge/shared";
import type { PipelineOptions, ToolOutcome } from "./reliability.js";
import type { RelayTransport } from "./relay-transport.js";
import { runGetWorldInfo, showImageFilename } from "./tools.js";
import { renderGuide, renderOverlay } from "./floorplan-render.js";
import { finishFloorplan, realFloorplanDeps, type FloorplanApply, type FloorplanDeps } from "./floorplan-finish.js";
import type { ImageJobRegistry } from "./image-tools.js";
import { settleJob } from "./image-tools.js";

export const FloorplanSceneShape = {
  ...FloorplanSchema.shape,
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1).default("generated-images").describe("Foundry directory the picture is uploaded to"),
  waitSeconds: z.number().int().min(0).max(600).default(90).describe("How long to wait for Codex before returning a jobId to poll with check_image_job"),
};
export type FloorplanSceneArgs = z.input<z.ZodObject<typeof FloorplanSceneShape>>;

const fail = (code: "VALIDATION" | "UNSUPPORTED" | "CONFLICT", message: string): ToolOutcome => ({ ok: false, error: { code, message }, steps: [] });

export function buildFloorplanPrompt(plan: Floorplan): string {
  const rooms = plan.rooms
    .map((r) => `- ${r.name ?? r.id}: ${r.floor ? `${r.floor} floor, ` : ""}furnished with ${r.furnishings.length ? r.furnishings.join(", ") : "a few plain furnishings"}`)
    .join("\n");
  return (
    `Paint a ${plan.style} as a strictly top-down orthographic floorplan for a tabletop RPG map, exactly over the attached blueprint. ` +
    "Keep every wall, doorway and window exactly where the blueprint has it, and keep the image the same size and proportions. " +
    "Brown bars are doors, light-blue bars are windows (draw glass), the green area outside is grass or ground.\n\n" +
    `Rooms:\n${rooms}\n\n` +
    "Light sources (fireplaces, torches, candles) must look lit. No grid lines, no text, no labels, no characters or creatures, no UI."
  );
}

export async function runBuildFloorplanScene(
  jobs: ImageJobRegistry,
  outputDir: string,
  transport: RelayTransport,
  args: FloorplanSceneArgs,
  opts: PipelineOptions = {},
  deps: FloorplanDeps = realFloorplanDeps,
): Promise<ToolOutcome> {
  const { source, target, waitSeconds, ...spec } = z.object(FloorplanSceneShape).parse(args);
  const plan = FloorplanSchema.parse(spec);
  const geo = buildGeometry(plan);
  if (!geo.ok) return fail("VALIDATION", geo.errors.join("; "));

  // Door animation is a Foundry 14 field; on 13 the module would silently drop it.
  const info = await runGetWorldInfo(transport, {} as never, opts);
  const major = Number.parseInt(String(info.ok ? (info.data as { foundryVersion?: string }).foundryVersion ?? "" : ""), 10);
  if (Number.isFinite(major) && major < 14) return fail("UNSUPPORTED", `Animated doors need Foundry 14 (this world runs ${major}). Use add_walls and add_lights directly.`);

  await mkdir(outputDir, { recursive: true });
  const stamp = showImageFilename(plan.name, "");
  const guidePath = join(outputDir, `guide-${stamp}.png`);
  const overlayPath = join(outputDir, `overlay-${stamp}.png`);
  await writeFile(guidePath, renderGuide(plan, geo.walls));
  await writeFile(overlayPath, renderOverlay(plan, geo.walls, geo.lights));
  const apply: FloorplanApply = { to: "floorplanScene", plan, walls: geo.walls, lights: geo.lights, overlayPath };

  if (!plan.codex) return finishFloorplan({ file: guidePath, apply, source, target, deps }, transport, opts);

  const px = plan.pxPerCell;
  const request = {
    prompt: buildFloorplanPrompt(plan) + (plan.seed ? `\n\nVariation seed: ${plan.seed}` : ""),
    width: plan.cols * px,
    height: plan.rows * px,
    outPath: join(outputDir, `floorplan-${stamp}.webp`),
    guidePath,
  };
  const job = jobs.start(request, { kind: "battlemap", subject: plan.name, apply, source, target });
  if (!job) return fail("CONFLICT", "Two images are already being generated; wait for one to finish or cancel it (cancel_image_job).");
  const current = (await jobs.wait(job.id, waitSeconds * 1000)) ?? job;
  return settleJob(current, transport, opts, deps);
}
```

- [ ] **Step 6: Wire `image-tools.ts`**

- Export the existing private `settle` as `settleJob(job, transport, opts, deps?)` (rename; keep `settle` as an alias used inside the file) and pass `deps` through to `followUp`.
- `export type ImageApply = z.infer<typeof ApplySchema> | FloorplanApply;` (import the type from `floorplan-finish.ts`). `GenerateImageShape.apply` keeps `ApplySchema.optional()` so the public tool never accepts `floorplanScene`.
- At the top of `followUp`, after `const result = ...`:

```ts
  if (apply?.to === "floorplanScene") {
    return finishFloorplan({ file, apply, source, target, deps }, transport, opts);
  }
```

  (`switch (apply.to)` below stays exhaustive over the other variants; TypeScript narrows after the early return.)

- [ ] **Step 7: Register in `server.ts`**

```ts
  register(
    "build_floorplan_scene",
    "Build a complete building scene from a small floorplan spec in one call: rooms (grid cells, furnishings), openings (doors with Foundry 14 animation, windows, secret doors, locked doors) and lights (torch, fireplace, candle, lantern, daylight, with flicker animation). The tool draws a blueprint, has Codex paint the floorplan over it as a webp, creates a square-grid scene exactly cols x rows cells, and derives every wall, door, window and light from the spec so they line up with the picture. Returns { sceneId, preview, overlay, warnings }; look at the preview (walls red, doors green, windows cyan, lights yellow over the picture) before play. codex:false keeps the plain blueprint as the map. Slow Codex runs return { jobId, status: \"running\" }: poll with check_image_job. Undo with undo_change by requestId (scene, walls and lights together). Needs Foundry 14.",
    FloorplanSceneShape,
    (transport, args, callOpts) => (images ? runBuildFloorplanScene(images.jobs, images.outputDir, transport, args, callOpts) : Promise.resolve(NO_IMAGES)),
  );
```

Add `build_floorplan_scene` to the README tool list.

- [ ] **Step 8: Run to verify they pass, then everything**

Run: `npx vitest run test/integration/floorplan-tool.test.ts && npm run typecheck && npm test && npm run selftest`
Expected: PASS. If `selftest` lists an expected tool count, update it.

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-server/src test/integration/floorplan-tool.test.ts README.md
git commit -m "build_floorplan_scene: one call from floorplan spec to a playable scene

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Try it for real on the Test-mcp world and fix what it shows

**Files:** whatever the findings need, in the bridge; a scratch script under the session scratchpad is fine for the call itself.

- [ ] **Step 1:** In the bridge checkout run `npm run install:foundry` and press Cmd+R in the Test-mcp GM window (the module does not change in this plan, but this confirms 0.6.0+ is loaded). Free port 8787 if a Codex/Claude `foundry` MCP server holds it.
- [ ] **Step 2:** Call `build_floorplan_scene` with the `house` object from Task 6 (but `pxPerCell: 100`) through `connectBridge` from `scripts/lib/bridge-live/mcp.mjs`, `codex: true`, `waitSeconds: 600`. Open the returned `overlay`/preview and the scene in Foundry. Record: did Codex respect the guide (walls within about half a wall thickness, 6 px at 100 px/cell)? Do doors animate when opened? Do the torches and fireplaces flicker? Does a window let you see through but not walk?
- [ ] **Step 3:** If alignment is poor, tighten the prompt in `buildFloorplanPrompt` (and nothing else); rerun. If Codex ignores the guide entirely, apply the spec's fallback (layout described in words, rely on the overlay) and say so in the PR.
- [ ] **Step 4:** Delete the test scene and uploaded files through the bridge (`undo_change` by requestId, then the files via the Foundry file browser or leave in `Data/generated-images`; mention it).
- [ ] **Step 5:** Commit any prompt or code fixes with a message that names what the live run showed.

---

### Task 8: Live test group, docs and the vendored copy

**Files:**
- Bridge: `docs/foundry-live-api-plan.md` or `README.md` (tool list + one example call), nothing else.
- curse-of-strahd repo: `scripts/lib/bridge-live/suites.mjs` (add `build_floorplan_scene` to `EXPECTED_TOOLS`; add a group "9. Floorplan" after "8. Safety switches"), `docs/bridge-live-test.md`, and re-copy `scripts/gen-image.mjs` to `.claude/skills/generate-image/gen-image.mjs` (the vendored copy, per `CLAUDE.md`: never hand-edit; copy from the bridge after the PR is merged).

- [ ] **Step 1: Write the live group** (curse-of-strahd repo). Follow the pattern of group 6 (fake Codex, `ctx.call`, `ctx.track` for cleanup). Build the small three-room `house` with `codex: true` against the fake Codex (`fake-codex.mjs` already writes valid images; check that it honours `-i` by ignoring unknown args, and extend it only if it fails on them), then read the scene back with `get_scene_state` and assert: scene size, 3 door walls with `animation` fields, 2 windows (`sight === 0`), 2 animated lights, and that `delete_document` of the scene removes it (cleanup is automatic through `ctx.track`).
- [ ] **Step 2: Run it:** `npm run test:bridge-live:all -- --no-update --expect-world "Test-MCP"`; expected: all groups pass including "9. Floorplan". The tool list check fails until the bridge with this feature is merged and pulled, which is expected: run it from the merged `main`.
- [ ] **Step 3:** After the bridge PR is merged: copy `scripts/gen-image.mjs` into `.claude/skills/generate-image/gen-image.mjs`, run `npm run tools:check`, commit both repos' changes as separate PRs.

---

## Self-review notes

- Spec coverage: layout-first single call (Tasks 3, 6), guide image and Codex painting (4, 5, 6), webp (6, mime fix), scene at exact grid (6, `fitImage`), walls/doors/windows from geometry (3), animated doors (1, 3), lights with animation and presets (1, 3), preview (4, 6), v13 refusal (6), live test (8), tool-list and docs (6, 8). The spec's window `DISTANCE`/threshold wording is deliberately replaced (Global Constraints, Task 2 spec edit).
- Types used across tasks: `WallSegment`, `PlacedLight`, `DoorOptions`, `Floorplan`, `ImageRequest.guidePath`, `buildCodexArgv`, `Raster`, `renderGuide`, `renderOverlay`, `fitImage`, `compositePreview`, `hasMagick`, `runBuildFloorplanScene` are defined in the task that produces them before any task that consumes them.
- Cross-task contracts: `PlacedLight.source` (Task 3) feeds `add_lights` presets in Task 6; `imageSize` (added in Task 6 step 1) and `FloorplanDeps` keep the tool tests independent of an installed ImageMagick.
