/**
 * Foundry V14 Scene + embedded document builders.
 *
 * Ported from the campaign repo's offline `import-scenes.js` so the live path and the
 * offline LevelDB importer share one source of truth for document shape. The live path
 * does NOT use the LevelDB `_key` field (the server assigns storage keys), so builders
 * here emit clean document data only.
 */

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomId(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)] ?? "0";
  }
  return out;
}

export interface LightSpec {
  x?: number;
  y?: number;
  walls?: boolean;
  alpha?: number;
  angle?: number;
  bright?: number;
  color?: string;
  coloration?: number;
  dim?: number;
  attenuation?: number;
  luminosity?: number;
  animation?: { type?: string | null; speed?: number; intensity?: number; reverse?: boolean };
}

export interface TokenSpec {
  x?: number;
  y?: number;
  elevation?: number;
  hidden?: boolean;
  disposition?: number;
}

export interface NoteSpec {
  x?: number;
  y?: number;
  icon?: string;
  iconSize?: number;
  text?: string;
}

export interface SceneSpec {
  name: string;
  width?: number;
  height?: number;
  padding?: number;
  backgroundColor?: string;
  tokenVision?: boolean;
  background?: { src?: string | null; fit?: string };
  grid?: { type?: number; size?: number; distance?: number; units?: string };
  environment?: { darknessLevel?: number; globalLight?: boolean };
}

export interface ActorRef {
  _id: string;
  name: string;
  prototypeToken?: Record<string, unknown>;
}

export interface JournalRef {
  _id: string;
  name: string;
  firstPageId?: string | null;
}

export function buildLight(spec: LightSpec): Record<string, unknown> {
  const a = spec.animation ?? {};
  return {
    _id: randomId(),
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    rotation: 0,
    elevation: 0,
    walls: spec.walls ?? true,
    vision: false,
    hidden: false,
    config: {
      negative: false,
      priority: 0,
      alpha: spec.alpha ?? 0.5,
      angle: spec.angle ?? 360,
      bright: spec.bright ?? 0,
      color: spec.color ?? "#ff9329",
      coloration: spec.coloration ?? 1,
      dim: spec.dim ?? 0,
      attenuation: spec.attenuation ?? 0.5,
      luminosity: spec.luminosity ?? 0.5,
      saturation: 0,
      contrast: 0,
      shadows: 0,
      animation: {
        type: a.type ?? null,
        speed: a.speed ?? 5,
        intensity: a.intensity ?? 5,
        reverse: a.reverse ?? false,
      },
      darkness: { min: 0, max: 1 },
    },
    flags: {},
  };
}

export function buildToken(spec: TokenSpec, actor: ActorRef): Record<string, unknown> {
  const proto = actor.prototypeToken ?? {};
  return {
    ...proto,
    _id: randomId(),
    name: (proto["name"] as string | undefined) ?? actor.name,
    actorId: actor._id,
    actorLink: (proto["actorLink"] as boolean | undefined) ?? false,
    delta: {},
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    elevation: spec.elevation ?? 0,
    sort: 0,
    hidden: spec.hidden ?? false,
    disposition: spec.disposition ?? (proto["disposition"] as number | undefined) ?? 0,
  };
}

export function buildNote(spec: NoteSpec, journal: JournalRef): Record<string, unknown> {
  return {
    _id: randomId(),
    entryId: journal._id,
    pageId: journal.firstPageId ?? null,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    elevation: 0,
    sort: 0,
    texture: { src: spec.icon ?? "icons/svg/book.svg", tint: null },
    iconSize: spec.iconSize ?? 40,
    text: spec.text ?? journal.name,
    fontFamily: "Signika",
    fontSize: 32,
    textAnchor: 1,
    textColor: "#ffffff",
    global: false,
    flags: {},
  };
}

export function buildScene(spec: SceneSpec, backgroundSrc: string | null): Record<string, unknown> {
  const grid = spec.grid ?? {};
  const env = spec.environment ?? {};
  return {
    name: spec.name,
    active: false,
    navigation: true,
    navName: "",
    background: {
      src: backgroundSrc,
      anchorX: 0.5,
      anchorY: 0.5,
      offsetX: 0,
      offsetY: 0,
      fit: spec.background?.fit ?? "fill",
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      tint: "#ffffff",
      alphaThreshold: 0,
    },
    foreground: null,
    foregroundElevation: 20,
    thumb: null,
    width: spec.width ?? 2000,
    height: spec.height ?? 1400,
    padding: spec.padding ?? 0.25,
    initial: { x: null, y: null, scale: null },
    backgroundColor: spec.backgroundColor ?? "#000000",
    grid: {
      type: grid.type ?? 0,
      size: grid.size ?? 100,
      style: "solidLines",
      thickness: 1,
      color: "#000000",
      alpha: 0.2,
      distance: grid.distance ?? 5,
      units: grid.units ?? "ft",
    },
    tokenVision: spec.tokenVision ?? true,
    fog: {
      exploration: true,
      reset: null,
      overlay: null,
      colors: { explored: null, unexplored: null },
    },
    environment: {
      darknessLevel: env.darknessLevel ?? 0,
      darknessLock: false,
      globalLight: {
        enabled: !!env.globalLight,
        alpha: 0.5,
        bright: false,
        color: null,
        coloration: 1,
        luminosity: 0,
        saturation: 0,
        contrast: 0,
        shadows: 0,
        darkness: { min: 0, max: 0 },
      },
      cycle: true,
      base: { hue: 0, intensity: 0, luminosity: 0, saturation: 0, shadows: 0 },
      dark: { hue: 0, intensity: 0, luminosity: 0, saturation: 0, shadows: 0 },
    },
    weather: "",
    drawings: [],
    tokens: [],
    lights: [],
    notes: [],
    sounds: [],
    regions: [],
    templates: [],
    tiles: [],
    walls: [],
    flags: {},
  };
}
