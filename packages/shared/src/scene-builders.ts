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
    backgroundColor: input.backgroundColor ?? "#999999",
    background: input.background ? { src: input.background } : null,
    grid: {
      type: input.gridType ?? GRID_TYPES.SQUARE,
      size: input.gridSize ?? 100,
      distance: input.gridDistance ?? 5,
      units: input.gridUnits ?? "ft",
      color: "#000000",
      alpha: 0.2,
    },
    initial: null,
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
  return deepMerge(scene, override);
}
