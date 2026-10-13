/**
 * Scene / token / canvas tools. They speak in grid squares: each tool reads the
 * scene's grid once (getSceneState), converts squares to pixels with the shared
 * builders, and then runs the ordinary embedded-document pipelines, so read-back,
 * rollback and slim echoes behave exactly as for create_embedded and friends.
 */

import { z } from "zod";
import {
  GRID_TYPES,
  SceneStateSchema,
  TOKEN_DISPOSITIONS,
  buildLight,
  buildToken,
  buildWallFromGrid,
  resolveLightInput,
  gridToPixels,
  type SceneState,
  DOOR_STYLES,
} from "@foundry-mcp-bridge/shared";
import type { RelayTransport } from "./relay-transport.js";
import {
  activateSceneReliable,
  createEmbeddedReliable,
  deleteEmbeddedReliable,
  getSceneStateReliable,
  runRead,
  toggleConditionReliable,
  updateEmbeddedReliable,
  type PipelineOptions,
  type ToolOutcome,
} from "./reliability.js";

const fail = (code: "VALIDATION" | "UNSUPPORTED" | "NOT_FOUND", message: string): ToolOutcome => ({
  ok: false,
  error: { code, message },
  steps: [],
});

/** Prefix the preparatory read steps onto a write outcome so traces keep the whole path. */
const withSteps = (before: string[], out: ToolOutcome): ToolOutcome => ({ ...out, steps: [...before, ...out.steps] });

interface GridResult {
  size: number;
  /** Foundry's own pixel origin of grid square (0,0), straight from the module. */
  origin: { x: number; y: number };
  steps: string[];
}

/** Grid size + origin of a scene, or a structured failure (hex grids are not mapped to squares). */
async function loadGrid(
  transport: RelayTransport,
  sceneId: string,
  opts: PipelineOptions,
): Promise<GridResult | ToolOutcome> {
  const read = await getSceneStateReliable(transport, { id: sceneId }, opts);
  if (!read.ok) return read;
  const parsed = SceneStateSchema.safeParse(read.data);
  if (!parsed.success) {
    return { ok: false, error: { code: "INTERNAL", message: `Module returned a malformed scene state: ${parsed.error.message}` }, steps: read.steps };
  }
  const state: SceneState = parsed.data;
  if (state.grid.type !== GRID_TYPES.SQUARE && state.grid.type !== GRID_TYPES.GRIDLESS) {
    return {
      ...fail(
        "UNSUPPORTED",
        "Grid-square coordinates only work on square or gridless scenes; use create_embedded with pixel x/y on hex grids",
      ),
      steps: read.steps,
    };
  }
  return { size: state.grid.size, origin: state.origin, steps: read.steps };
}

const isOutcome = (r: GridResult | ToolOutcome): r is ToolOutcome => "ok" in r;

const sceneId = z.string().min(1).describe("Scene id");
const square = z.number().int().describe("Grid column/row, 0 = top-left square of the map (not the padding)");
const DISPOSITIONS = { friendly: TOKEN_DISPOSITIONS.FRIENDLY, neutral: TOKEN_DISPOSITIONS.NEUTRAL, hostile: TOKEN_DISPOSITIONS.HOSTILE, secret: TOKEN_DISPOSITIONS.SECRET } as const;

// --- list_scenes / get_scene_state / switch_scene ----------------------------

export const ListScenesShape = {};
export async function runListScenes(transport: RelayTransport, _args: object = {}, opts: PipelineOptions = {}): Promise<ToolOutcome> {
  const out = await runRead(transport, { action: "find", documentType: "Scene" }, "find", opts);
  if (!out.ok || !Array.isArray(out.data)) return out;
  const scenes = (out.data as Array<Record<string, any>>).map((scene) => ({
    _id: scene._id,
    name: scene.name,
    active: scene.active ?? false,
    grid: scene.grid?.size,
    size: [scene.width, scene.height],
    tokens: Array.isArray(scene.tokens) ? scene.tokens.length : 0,
  }));
  return { ...out, data: scenes };
}

export const GetSceneStateShape = {
  id: z.string().min(1).optional().describe("Scene id; omit for the scene the GM is viewing"),
};
export type GetSceneStateArgs = z.infer<z.ZodObject<typeof GetSceneStateShape>>;
export function runGetSceneState(transport: RelayTransport, args: GetSceneStateArgs, opts: PipelineOptions = {}) {
  return getSceneStateReliable(transport, args, opts);
}

export const SwitchSceneShape = {
  id: sceneId,
  mode: z.enum(["activate", "view"]).default("activate").describe("activate = the table sees it; view = only the GM"),
};
export type SwitchSceneArgs = z.input<z.ZodObject<typeof SwitchSceneShape>>;
export function runSwitchScene(transport: RelayTransport, args: SwitchSceneArgs, opts: PipelineOptions = {}) {
  return activateSceneReliable(transport, args, opts);
}

// --- place_token / move_tokens / remove_tokens / toggle_condition --------------

export const PlaceTokenShape = {
  sceneId,
  actorId: z.string().min(1).optional().describe("Actor to place; its name is used unless `name` is given"),
  name: z.string().min(1).optional(),
  col: square,
  row: square,
  width: z.number().positive().optional().describe("Size in grid squares (default 1)"),
  height: z.number().positive().optional(),
  src: z.string().min(1).optional().describe("Token image path; defaults to the actor's token art"),
  hidden: z.boolean().optional(),
  disposition: z.enum(["friendly", "neutral", "hostile", "secret"]).optional().describe("Default hostile"),
  actorLink: z.boolean().optional().describe("Link to the world actor instead of a synthetic copy"),
};
export type PlaceTokenArgs = z.infer<z.ZodObject<typeof PlaceTokenShape>>;

export async function runPlaceToken(transport: RelayTransport, args: PlaceTokenArgs, opts: PipelineOptions = {}): Promise<ToolOutcome> {
  const steps: string[] = [];
  let name = args.name;
  let src = args.src;
  if (args.actorId) {
    // Always resolve the actor: a missing actor fails before any write, and its prototype
    // token art is the default image (an explicit `src` still wins).
    const actor = await runRead(transport, { action: "find", documentType: "Actor", id: args.actorId }, "find", opts);
    if (!actor.ok) return actor;
    steps.push(...actor.steps);
    const doc = actor.data as { name?: string; img?: string; prototypeToken?: { texture?: { src?: string } } };
    name ??= doc.name ?? "Token";
    src ??= doc.prototypeToken?.texture?.src ?? doc.img;
  }
  if (!name) return fail("VALIDATION", "place_token needs a name or an actorId");
  const gridResult = await loadGrid(transport, args.sceneId, opts);
  if (isOutcome(gridResult)) return gridResult;
  steps.push(...gridResult.steps);
  const { x, y } = gridToPixels(args.col, args.row, gridResult.size, gridResult.origin);
  const token = buildToken({
    name,
    x,
    y,
    actorId: args.actorId,
    width: args.width,
    height: args.height,
    src,
    hidden: args.hidden,
    disposition: args.disposition ? DISPOSITIONS[args.disposition] : undefined,
    actorLink: args.actorLink,
  });
  return withSteps(
    steps,
    await createEmbeddedReliable(transport, { parentType: "Scene", parentId: args.sceneId, embeddedName: "Token", data: [token] }, opts),
  );
}

export const MoveTokensShape = {
  sceneId,
  moves: z.array(z.object({ tokenId: z.string().min(1), col: square, row: square })).min(1),
};
export type MoveTokensArgs = z.infer<z.ZodObject<typeof MoveTokensShape>>;
export async function runMoveTokens(transport: RelayTransport, args: MoveTokensArgs, opts: PipelineOptions = {}): Promise<ToolOutcome> {
  const gridResult = await loadGrid(transport, args.sceneId, opts);
  if (isOutcome(gridResult)) return gridResult;
  const data = args.moves.map((move) => ({ _id: move.tokenId, ...gridToPixels(move.col, move.row, gridResult.size, gridResult.origin) }));
  return withSteps(
    gridResult.steps,
    await updateEmbeddedReliable(transport, { parentType: "Scene", parentId: args.sceneId, embeddedName: "Token", data }, opts),
  );
}

export const RemoveTokensShape = { sceneId, tokenIds: z.array(z.string().min(1)).min(1) };
export type RemoveTokensArgs = z.infer<z.ZodObject<typeof RemoveTokensShape>>;
export function runRemoveTokens(transport: RelayTransport, args: RemoveTokensArgs, opts: PipelineOptions = {}) {
  return deleteEmbeddedReliable(
    transport,
    { parentType: "Scene", parentId: args.sceneId, embeddedName: "Token", ids: args.tokenIds },
    opts,
  );
}

export const ToggleConditionShape = {
  sceneId,
  tokenId: z.string().min(1),
  statusId: z.string().min(1).describe('Status id such as "prone", "poisoned", "blinded", "dead"'),
  active: z.boolean().optional().describe("Force on/off; omit to flip"),
};
export type ToggleConditionArgs = z.infer<z.ZodObject<typeof ToggleConditionShape>>;
export function runToggleCondition(transport: RelayTransport, args: ToggleConditionArgs, opts: PipelineOptions = {}) {
  return toggleConditionReliable(transport, args, opts);
}

// --- add_walls / add_lights ----------------------------------------------------

export const AddWallsShape = {
  sceneId,
  walls: z
    .array(
      z.object({
        x1: z.number().describe("Grid CORNER coordinates (0,0 = top-left corner of the map), fractions allowed"),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        kind: z.enum(["wall", "door", "secretDoor", "limited", "window"]).optional().describe("limited = blocks movement, Limited sight/light (see through one, blocked by two). window = blocks movement only, sight and light pass (glass). Not Foundry's distance-based Proximity wall; make that with create_embedded."),
        animation: z.enum(["swing", "slide", "swivel", "ascend", "descend"]).optional().describe("Foundry 14 door animation (doors only). Default follows the style: swing, slide for stone, ascend for a portcullis"),
        style: z.enum(DOOR_STYLES).optional().describe("Door look from Foundry's core door images in canvas/doors: wood (default), stone, metal, portcullis. Every door gets one, Foundry only animates a door that has a texture"),
        tone: z.string().optional().describe("Narrow the style to a colour: wood dark/walnut/light/red/ashen, stone volcanic/earthy/redrock, metal rusty/gray"),
        texture: z.string().optional().describe("Your own door image path; wins over style"),
        double: z.boolean().optional().describe("Double door (doors only)"),
        flip: z.boolean().optional(),
        locked: z.boolean().optional().describe("Door starts locked"),
        open: z.boolean().optional().describe("Door starts open"),
      }),
    )
    .min(1),
};
export type AddWallsArgs = z.infer<z.ZodObject<typeof AddWallsShape>>;
export async function runAddWalls(transport: RelayTransport, args: AddWallsArgs, opts: PipelineOptions = {}): Promise<ToolOutcome> {
  const gridResult = await loadGrid(transport, args.sceneId, opts);
  if (isOutcome(gridResult)) return gridResult;
  const data = args.walls.map(({ animation, style, tone, texture, double, flip, locked, open, ...seg }) =>
    buildWallFromGrid({ ...seg, doorOptions: { animation, style, tone, texture, double, flip, locked, open } }, gridResult.size, gridResult.origin),
  );
  return withSteps(
    gridResult.steps,
    await createEmbeddedReliable(transport, { parentType: "Scene", parentId: args.sceneId, embeddedName: "Wall", data }, opts),
  );
}

export const AddLightsShape = {
  sceneId,
  lights: z
    .array(
      z.object({
        col: z.number().describe("Grid column (fractions allowed; +0.5 = centre of the square)"),
        row: z.number(),
        bright: z.number().min(0).optional().describe("Bright radius in the scene's distance units (e.g. feet)"),
        dim: z.number().min(0).optional().describe("Dim radius in the scene's distance units"),
        color: z.string().optional().describe('Hex colour such as "#ffaa55"'),
        source: z.enum(["torch", "fireplace", "candle", "lantern", "daylight"]).optional().describe("Preset: radii, colour and animation; explicit fields override it"),
        animation: z.string().optional().describe("Foundry light animation key, e.g. torch, flame, pulse"),
      }),
    )
    .min(1),
};
export type AddLightsArgs = z.infer<z.ZodObject<typeof AddLightsShape>>;
export async function runAddLights(transport: RelayTransport, args: AddLightsArgs, opts: PipelineOptions = {}): Promise<ToolOutcome> {
  const gridResult = await loadGrid(transport, args.sceneId, opts);
  if (isOutcome(gridResult)) return gridResult;
  const data = args.lights.map((light) => {
    const { x, y } = gridToPixels(light.col, light.row, gridResult.size, gridResult.origin);
    const r = resolveLightInput(light);
    return buildLight({ x, y, bright: r.bright, dim: r.dim, color: r.color, animation: r.animation });
  });
  return withSteps(
    gridResult.steps,
    await createEmbeddedReliable(transport, { parentType: "Scene", parentId: args.sceneId, embeddedName: "AmbientLight", data }, opts),
  );
}
