/**
 * V14 scene payload builders. Pure functions: they only construct plain data
 * objects matching Foundry V14's document shapes (grid-as-object since v12,
 * config-nested ambient lights, texture-nested tokens/notes). No I/O.
 *
 * Each builder accepts a small, ergonomic input and deep-merges caller overrides
 * so advanced fields stay reachable without re-specifying defaults.
 */

import { type Json, deepMerge } from "./objects.js";

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

/**
 * Pixel origin of grid square (0,0): Foundry pads the canvas around the scene rect,
 * rounded up to a whole grid square (`Scene#getDimensions`). Takes the scene's stored
 * `width`, `height`, `padding` and `grid.size`.
 */
export function sceneOrigin(scene: { width: number; height: number; padding?: number; grid: { size: number } }): {
  x: number;
  y: number;
} {
  const padding = scene.padding ?? 0.25;
  const size = scene.grid.size;
  return { x: Math.ceil((scene.width * padding) / size) * size, y: Math.ceil((scene.height * padding) / size) * size };
}

/** Foundry wall document from a grid-coordinate segment (corners, not squares). */
export function buildWallFromGrid(
  seg: { x1: number; y1: number; x2: number; y2: number; kind?: "wall" | "door" | "secretDoor" | "window" },
  gridSize: number,
  origin: { x?: number; y?: number } = {},
): Json {
  const a = gridToPixels(seg.x1, seg.y1, gridSize, origin);
  const b = gridToPixels(seg.x2, seg.y2, gridSize, origin);
  const kind = seg.kind ?? "wall";
  // CONST.WALL_DOOR_TYPES: 0 none, 1 door, 2 secret. Window = sight-only (limited=10 light/sight).
  const door = kind === "door" ? 1 : kind === "secretDoor" ? 2 : 0;
  const wall: Json = {
    _id: randomID(),
    c: [a.x, a.y, b.x, b.y],
    door,
    ds: 0,
    move: 20,
    sight: 20,
    light: 20,
    sound: 20,
    dir: 0,
  };
  if (kind === "window") {
    wall.sight = 10;
    wall.light = 10;
  }
  return wall;
}

type Doc = Record<string, any>;
const pick = (doc: Doc, keys: string[]): Json => {
  const out: Json = {};
  for (const k of keys) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
};

/**
 * Compact, planning-friendly snapshot of a Scene's stored data (plain object, as
 * from `toObject()`). Pure so the module and the mock return the same shape.
 */
export function buildSceneState(scene: Doc): Json {
  const grid = scene.grid ?? {};
  const list = (arr: unknown): Doc[] => (Array.isArray(arr) ? (arr as Doc[]) : []);
  return {
    _id: scene._id,
    name: scene.name,
    active: scene.active ?? false,
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    grid: { type: grid.type, size: grid.size, distance: grid.distance, units: grid.units },
    background: scene.background?.src ?? null,
    tokens: list(scene.tokens).map((t) => ({
      ...pick(t, ["_id", "name", "x", "y", "width", "height", "actorId", "hidden", "disposition"]),
      conditions: Array.isArray(t.statuses) ? t.statuses : undefined,
    })),
    walls: list(scene.walls).map((w) => pick(w, ["_id", "c", "door", "move", "sight"])),
    lights: list(scene.lights).map((l) => ({
      ...pick(l, ["_id", "x", "y"]),
      bright: l.config?.bright,
      dim: l.config?.dim,
    })),
    tiles: list(scene.tiles).map((t) => ({
      ...pick(t, ["_id", "x", "y", "width", "height", "hidden"]),
      src: t.texture?.src,
    })),
    notes: list(scene.notes).map((n) => pick(n, ["_id", "x", "y", "entryId", "text"])),
  };
}
