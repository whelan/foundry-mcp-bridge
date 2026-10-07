/**
 * Scene / token / canvas tools. They speak in grid squares: each tool reads the
 * scene's grid once (getSceneState), converts squares to pixels with the shared
 * builders, and then runs the ordinary embedded-document pipelines, so read-back,
 * rollback and slim echoes behave exactly as for create_embedded and friends.
 */

import { z } from "zod";
import {
  GRID_TYPES,
  TOKEN_DISPOSITIONS,
  buildLight,
  buildToken,
  buildWallFromGrid,
  gridToPixels,
  sceneOrigin,
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

interface GridInfo {
  size: number;
  origin: { x: number; y: number };
}

/** Grid size + origin of a scene, or a structured failure (hex grids are not mapped to squares). */
async function loadGrid(
  transport: RelayTransport,
  sceneId: string,
  opts: PipelineOptions,
): Promise<{ grid: GridInfo } | { outcome: ToolOutcome }> {
  const state = await getSceneStateReliable(transport, { id: sceneId }, opts);
  if (!state.ok) return { outcome: state };
  const s = state.data as { width: number; height: number; padding?: number; grid: { type: number; size: number } };
  if (s.grid.type !== GRID_TYPES.SQUARE && s.grid.type !== GRID_TYPES.GRIDLESS) {
    return {
      outcome: fail(
        "UNSUPPORTED",
        "Grid-square coordinates only work on square or gridless scenes; use create_embedded with pixel x/y on hex grids",
      ),
    };
  }
  return { grid: { size: s.grid.size, origin: sceneOrigin(s) } };
}

const sceneId = z.string().min(1).describe("Scene id");
const square = z.number().int().describe("Grid column/row, 0 = top-left square of the map (not the padding)");
const DISPOSITIONS = { friendly: TOKEN_DISPOSITIONS.FRIENDLY, neutral: TOKEN_DISPOSITIONS.NEUTRAL, hostile: TOKEN_DISPOSITIONS.HOSTILE, secret: TOKEN_DISPOSITIONS.SECRET } as const;

// --- list_scenes / get_scene_state / switch_scene ----------------------------

export const ListScenesShape = {};
export function runListScenes(transport: RelayTransport, _a: object = {}, opts: PipelineOptions = {}): Promise<ToolOutcome> {
  return runRead(transport, { action: "find", documentType: "Scene" }, "find", opts).then((out) =>
    out.ok && Array.isArray(out.data)
      ? {
          ...out,
          data: (out.data as Array<Record<string, any>>).map((s) => ({
            _id: s._id,
            name: s.name,
            active: s.active ?? false,
            grid: s.grid?.size,
            size: [s.width, s.height],
            tokens: Array.isArray(s.tokens) ? s.tokens.length : 0,
          })),
        }
      : out,
  );
}

export const GetSceneStateShape = {
  id: z.string().min(1).optional().describe("Scene id; omit for the scene the GM is viewing"),
};
export function runGetSceneState(transport: RelayTransport, args: { id?: string }, opts: PipelineOptions = {}) {
  return getSceneStateReliable(transport, args, opts);
}

export const SwitchSceneShape = {
  id: sceneId,
  mode: z.enum(["activate", "view"]).default("activate").describe("activate = the table sees it; view = only the GM"),
};
export function runSwitchScene(transport: RelayTransport, args: { id: string; mode?: "activate" | "view" }, opts: PipelineOptions = {}) {
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
  let name = args.name;
  if (!name && args.actorId) {
    const actor = await runRead(transport, { action: "find", documentType: "Actor", id: args.actorId }, "find", opts);
    if (!actor.ok) return actor;
    name = String((actor.data as { name?: string }).name ?? "Token");
  }
  if (!name) return fail("VALIDATION", "place_token needs a name or an actorId");
  const g = await loadGrid(transport, args.sceneId, opts);
  if ("outcome" in g) return g.outcome;
  const { x, y } = gridToPixels(args.col, args.row, g.grid.size, g.grid.origin);
  const token = buildToken({
    name,
    x,
    y,
    actorId: args.actorId,
    width: args.width,
    height: args.height,
    src: args.src,
    hidden: args.hidden,
    disposition: args.disposition ? DISPOSITIONS[args.disposition] : undefined,
    actorLink: args.actorLink,
  });
  return createEmbeddedReliable(
    transport,
    { parentType: "Scene", parentId: args.sceneId, embeddedName: "Token", data: [token] },
    opts,
  );
}

export const MoveTokensShape = {
  sceneId,
  moves: z.array(z.object({ tokenId: z.string().min(1), col: square, row: square })).min(1),
};
export async function runMoveTokens(
  transport: RelayTransport,
  args: { sceneId: string; moves: Array<{ tokenId: string; col: number; row: number }> },
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const g = await loadGrid(transport, args.sceneId, opts);
  if ("outcome" in g) return g.outcome;
  const data = args.moves.map((m) => ({ _id: m.tokenId, ...gridToPixels(m.col, m.row, g.grid.size, g.grid.origin) }));
  return updateEmbeddedReliable(transport, { parentType: "Scene", parentId: args.sceneId, embeddedName: "Token", data }, opts);
}

export const RemoveTokensShape = { sceneId, tokenIds: z.array(z.string().min(1)).min(1) };
export function runRemoveTokens(transport: RelayTransport, args: { sceneId: string; tokenIds: string[] }, opts: PipelineOptions = {}) {
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
export function runToggleCondition(
  transport: RelayTransport,
  args: { sceneId: string; tokenId: string; statusId: string; active?: boolean },
  opts: PipelineOptions = {},
) {
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
        kind: z.enum(["wall", "door", "secretDoor", "window"]).optional(),
      }),
    )
    .min(1),
};
export async function runAddWalls(
  transport: RelayTransport,
  args: { sceneId: string; walls: Array<{ x1: number; y1: number; x2: number; y2: number; kind?: "wall" | "door" | "secretDoor" | "window" }> },
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const g = await loadGrid(transport, args.sceneId, opts);
  if ("outcome" in g) return g.outcome;
  const data = args.walls.map((w) => buildWallFromGrid(w, g.grid.size, g.grid.origin));
  return createEmbeddedReliable(transport, { parentType: "Scene", parentId: args.sceneId, embeddedName: "Wall", data }, opts);
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
      }),
    )
    .min(1),
};
export async function runAddLights(
  transport: RelayTransport,
  args: { sceneId: string; lights: Array<{ col: number; row: number; bright?: number; dim?: number; color?: string }> },
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const g = await loadGrid(transport, args.sceneId, opts);
  if ("outcome" in g) return g.outcome;
  const data = args.lights.map((l) => {
    const { x, y } = gridToPixels(l.col, l.row, g.grid.size, g.grid.origin);
    return buildLight({ x, y, bright: l.bright, dim: l.dim, color: l.color });
  });
  return createEmbeddedReliable(transport, { parentType: "Scene", parentId: args.sceneId, embeddedName: "AmbientLight", data }, opts);
}
