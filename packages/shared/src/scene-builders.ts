/**
 * V14 scene payload builders. Pure functions: they only construct plain data
 * objects matching Foundry V14's document shapes (grid-as-object since v12,
 * config-nested ambient lights, texture-nested tokens/notes). No I/O.
 *
 * Each builder accepts a small, ergonomic input and deep-merges caller overrides
 * so advanced fields stay reachable without re-specifying defaults.
 */

import { z } from "zod";
import { type Json, deepMerge } from "./objects.js";
import { type DoorStyle, defaultDoorAnimation, pickDoorTexture } from "./door-textures.js";
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Foundry-style 16-char document id. */
export function randomID(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grid types (Foundry CONST.GRID_TYPES)
// ---------------------------------------------------------------------------

export const GRID_TYPES = {
  GRIDLESS: 0,
  SQUARE: 1,
  HEXODDR: 2,
  HEXEVENR: 3,
  HEXODDQ: 4,
  HEXEVENQ: 5,
} as const;

export const TOKEN_DISPOSITIONS = {
  SECRET: -2,
  HOSTILE: -1,
  NEUTRAL: 0,
  FRIENDLY: 1,
} as const;

// ---------------------------------------------------------------------------
// Ambient light
// ---------------------------------------------------------------------------

export interface BuildLightInput {
  x: number;
  y: number;
  /** Bright radius in grid units. */
  bright?: number;
  /** Dim radius in grid units. */
  dim?: number;
  color?: string | null;
  rotation?: number;
  angle?: number;
  animation?: { type?: string | null; speed?: number; intensity?: number };
}

export function buildLight(input: BuildLightInput, override?: Json): Json {
  const light: Json = {
    _id: randomID(),
    x: input.x,
    y: input.y,
    rotation: input.rotation ?? 0,
    walls: true,
    vision: false,
    config: {
      negative: false,
      priority: 0,
      alpha: 0.5,
      angle: input.angle ?? 360,
      bright: input.bright ?? 0,
      color: input.color ?? null,
      coloration: 1,
      dim: input.dim ?? 0,
      attenuation: 0.5,
      luminosity: 0.5,
      saturation: 0,
      contrast: 0,
      shadows: 0,
      animation: {
        type: input.animation?.type ?? null,
        speed: input.animation?.speed ?? 5,
        intensity: input.animation?.intensity ?? 5,
        reverse: false,
      },
      darkness: { min: 0, max: 1 },
    },
  };
  return deepMerge(light, override);
}

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

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export interface BuildTokenInput {
  name: string;
  x: number;
  y: number;
  actorId?: string;
  /** Size in grid squares. */
  width?: number;
  height?: number;
  src?: string;
  hidden?: boolean;
  disposition?: number;
  actorLink?: boolean;
}

export function buildToken(input: BuildTokenInput, override?: Json): Json {
  const token: Json = {
    _id: randomID(),
    name: input.name,
    x: input.x,
    y: input.y,
    width: input.width ?? 1,
    height: input.height ?? 1,
    actorId: input.actorId ?? null,
    actorLink: input.actorLink ?? false,
    hidden: input.hidden ?? false,
    disposition: input.disposition ?? TOKEN_DISPOSITIONS.HOSTILE,
    texture: {
      src: input.src ?? null,
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      tint: null,
    },
    sight: { enabled: false },
  };
  return deepMerge(token, override);
}

// ---------------------------------------------------------------------------
// Note (map note linking a JournalEntry)
// ---------------------------------------------------------------------------

export interface BuildNoteInput {
  x: number;
  y: number;
  entryId?: string;
  pageId?: string;
  text?: string;
  icon?: string;
  iconSize?: number;
  fontSize?: number;
  textColor?: string;
}

export function buildNote(input: BuildNoteInput, override?: Json): Json {
  const note: Json = {
    _id: randomID(),
    x: input.x,
    y: input.y,
    entryId: input.entryId ?? null,
    pageId: input.pageId ?? null,
    texture: { src: input.icon ?? "icons/svg/book.svg" },
    iconSize: input.iconSize ?? 40,
    text: input.text ?? "",
    fontFamily: "Signika",
    fontSize: input.fontSize ?? 32,
    textAnchor: 1,
    textColor: input.textColor ?? "#ffffff",
    global: false,
  };
  return deepMerge(note, override);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export interface BuildSceneInput {
  name: string;
  width?: number;
  height?: number;
  /** Grid square size in pixels. */
  gridSize?: number;
  gridType?: number;
  gridDistance?: number;
  gridUnits?: string;
  background?: string;
  backgroundColor?: string;
  padding?: number;
  tokens?: Json[];
  lights?: Json[];
  notes?: Json[];
}

export function buildScene(input: BuildSceneInput, override?: Json): Json {
  const scene: Json = {
    name: input.name,
    width: input.width ?? 4000,
    height: input.height ?? 3000,
    padding: input.padding ?? 0.25,
    grid: {
      type: input.gridType ?? GRID_TYPES.SQUARE,
      size: input.gridSize ?? 100,
      distance: input.gridDistance ?? 5,
      units: input.gridUnits ?? "ft",
      color: "#000000",
      alpha: 0.2,
    },
    tokens: input.tokens ?? [],
    lights: input.lights ?? [],
    notes: input.notes ?? [],
    walls: [],
    sounds: [],
    drawings: [],
    templates: [],
    tiles: [],
    regions: [],
  };
  // Include version-sensitive fields only when explicitly provided. V13 keeps
  // them at the top level; V14 migrates them into levels[0].background.* on
  // storage, so we cannot verify them by path after write.
  if (input.backgroundColor != null) scene.backgroundColor = input.backgroundColor;
  if (input.background != null) scene.background = { src: input.background };
  return deepMerge(scene, override);
}

/**
 * The subset of scene fields used for read-back verification. Excludes fields
 * that Foundry stores at different paths in V13 vs V14 (backgroundColor,
 * background, initial) so the same code works against both versions.
 */
export function buildSceneVerify(input: BuildSceneInput): Json {
  // Derive from buildScene so defaults can't drift between build and verify;
  // pick only the version-stable fields.
  const { name, width, height, padding, grid } = buildScene(input);
  return { name, width, height, padding, grid };
}

// ---------------------------------------------------------------------------
// Grid helpers (let callers speak in grid squares instead of pixels)
// ---------------------------------------------------------------------------

/** Top-left pixel of a grid square (square grids; gridless scenes use size as-is). */
export function gridToPixels(
  col: number,
  row: number,
  gridSize: number,
  origin: { x?: number; y?: number } = {},
): { x: number; y: number } {
  return { x: (origin.x ?? 0) + col * gridSize, y: (origin.y ?? 0) + row * gridSize };
}

/** Grid square containing a pixel point (inverse of {@link gridToPixels}). */
export function pixelsToGrid(
  x: number,
  y: number,
  gridSize: number,
  origin: { x?: number; y?: number } = {},
): { col: number; row: number } {
  return {
    col: Math.floor((x - (origin.x ?? 0)) / gridSize),
    row: Math.floor((y - (origin.y ?? 0)) / gridSize),
  };
}

/** CONST.WALL_MOVEMENT_TYPES / WALL_SENSE_TYPES / WALL_DOOR_TYPES (stable across v13–v14). */
export const WALL_MOVEMENT_TYPES = { NONE: 0, NORMAL: 20 } as const;
export const WALL_SENSE_TYPES = { NONE: 0, LIMITED: 10, NORMAL: 20 } as const;
export const WALL_DOOR_TYPES = { NONE: 0, DOOR: 1, SECRET: 2 } as const;
/** CONST.WALL_DOOR_STATES (Foundry 14). */
export const WALL_DOOR_STATES = { CLOSED: 0, OPEN: 1, LOCKED: 2 } as const;

export type WallKind = "wall" | "door" | "secretDoor" | "limited" | "window";
export type DoorAnimationType = "swing" | "slide" | "swivel" | "ascend" | "descend";

/** Foundry 14 door options. Every visible door gets an animation block: Foundry only animates a door that has a texture. */
export interface DoorOptions {
  animation?: DoorAnimationType;
  /** Look of the door (picks the core texture and, unless `animation` is given, the animation). Default wood. */
  style?: DoorStyle;
  /** Narrow the style to one colour, e.g. "dark" or "walnut" for wood. */
  tone?: string;
  /** A file path of your own; wins over `style`. Without a texture Foundry does not animate the door. */
  texture?: string;
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
  if (kind === "door") {
    const style = opts?.style ?? "wood";
    const cells = Math.hypot(b.x - a.x, b.y - a.y) / gridSize;
    const double = opts?.double ?? cells >= 2;
    const texture =
      opts?.texture ??
      pickDoorTexture(style, { wide: double, tone: opts?.tone, seed: Math.round((seg.x1 + seg.y1 * 7) * 2) }).path;
    wall.animation = {
      type: opts?.animation ?? defaultDoorAnimation(style),
      direction: opts?.direction ?? 1,
      double,
      flip: opts?.flip ?? false,
      duration: opts?.duration ?? 750,
      strength: opts?.strength ?? 1,
      texture,
    };
  }
  return wall;
}

// ---------------------------------------------------------------------------
// Scene state: the one contract between producer (module/mock) and consumers (tools)
// ---------------------------------------------------------------------------

export const SceneStateSchema = z.object({
  _id: z.string(),
  name: z.string(),
  active: z.boolean(),
  width: z.number(),
  height: z.number(),
  padding: z.number().optional(),
  grid: z.object({
    type: z.number(),
    size: z.number().positive(),
    distance: z.number().optional(),
    units: z.string().optional(),
  }),
  /**
   * Pixel position of grid square (0,0) as Foundry computes it (`scene.dimensions.sceneX/Y`,
   * including padding rounding and shifts). Token/wall/light pixels are relative to the canvas,
   * so tools must add this to grid → pixel conversions.
   */
  origin: z.object({ x: z.number(), y: z.number() }),
  /** Pre-V14 top-level background; null on V14 scenes (see `levels`). */
  background: z.string().nullable(),
  /** V14 levels with their own backgrounds. Which one the GM currently views is not reported. */
  levels: z.array(z.object({ _id: z.string(), name: z.string().optional(), background: z.string().nullable() })),
  tokens: z.array(
    z.object({
      _id: z.string(),
      name: z.string().optional(),
      x: z.number(),
      y: z.number(),
      width: z.number().optional(),
      height: z.number().optional(),
      actorId: z.string().nullable().optional(),
      hidden: z.boolean().optional(),
      disposition: z.number().optional(),
      /** Active status ids on the token's resolved actor (empty without an actor). */
      conditions: z.array(z.string()),
    }),
  ),
  walls: z.array(z.object({ _id: z.string(), c: z.array(z.number()), door: z.number().optional(), ds: z.number().optional(), move: z.number().optional(), sight: z.number().optional() })),
  lights: z.array(z.object({ _id: z.string(), x: z.number(), y: z.number(), bright: z.number().optional(), dim: z.number().optional() })),
  tiles: z.array(z.object({ _id: z.string(), x: z.number(), y: z.number(), width: z.number().optional(), height: z.number().optional(), hidden: z.boolean().optional(), src: z.string().nullable().optional() })),
  notes: z.array(z.object({ _id: z.string(), x: z.number(), y: z.number(), entryId: z.string().nullable().optional(), text: z.string().optional() })),
});
export type SceneState = z.infer<typeof SceneStateSchema>;

/** Facts only the runtime can resolve; the pure builder takes them as input. */
export interface SceneStateFacts {
  active: boolean;
  origin: { x: number; y: number };
  /** token _id → active status ids of its resolved (linked or synthetic) actor. */
  conditions: Record<string, string[]>;
}

type Raw = Record<string, any>;
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
const drop = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * Compact, planning-friendly snapshot of a Scene's stored data (as from `toObject()`),
 * normalising the V13 (top-level background) and V14 (levels) shapes. Pure so the module
 * and the mock produce the same {@link SceneState}.
 */
export function buildSceneState(scene: Raw, facts: SceneStateFacts): SceneState {
  const grid = scene.grid ?? {};
  return {
    _id: String(scene._id),
    name: String(scene.name ?? ""),
    active: facts.active,
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    grid: drop({ type: grid.type, size: grid.size, distance: grid.distance, units: grid.units }),
    origin: facts.origin,
    background: scene.background?.src ?? null,
    levels: arr(scene.levels).map((l) => drop({ _id: String(l._id), name: l.name, background: l.background?.src ?? null })),
    tokens: arr(scene.tokens).map((t) =>
      drop({
        _id: String(t._id),
        name: t.name,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        actorId: t.actorId,
        hidden: t.hidden,
        disposition: t.disposition,
        conditions: facts.conditions[t._id] ?? [],
      }),
    ),
    walls: arr(scene.walls).map((w) => drop({ _id: String(w._id), c: w.c, door: w.door, ds: w.ds, move: w.move, sight: w.sight })),
    lights: arr(scene.lights).map((l) => drop({ _id: String(l._id), x: l.x, y: l.y, bright: l.config?.bright, dim: l.config?.dim })),
    tiles: arr(scene.tiles).map((t) => drop({ _id: String(t._id), x: t.x, y: t.y, width: t.width, height: t.height, hidden: t.hidden, src: t.texture?.src })),
    notes: arr(scene.notes).map((n) => drop({ _id: String(n._id), x: n.x, y: n.y, entryId: n.entryId, text: n.text })),
  };
}
