/**
 * Everything after the pictures exist: fit and upload them, create the scene, then its levels (one per
 * floor), the walls and lights of each level, the stair regions and the roof tile. Walls and lights go
 * through add_walls / add_lights, which already read the grid origin Foundry applied and write
 * read-back-verified, logged, undoable embedded documents; levels, regions and the roof tile use the same
 * pipeline through create_embedded / update_embedded.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { gridToPixels, type Floorplan, type FloorGeometry, type PlacedStair } from "@foundry-mcp-bridge/shared";
import type { PipelineOptions, ToolOutcome } from "./reliability.js";
import type { RelayTransport } from "./relay-transport.js";
import { runCreateEmbedded, runCreateScene, runFindDocuments, runUpdateDocument, runUpdateEmbedded, runUploadAsset, showImageFilename } from "./tools.js";
import { isOutcome, loadGrid, runAddLights, runAddWalls } from "./scene-tools.js";
import { compositePreview, fitImage, hasMagick, imageSize, maskToFootprint } from "./floorplan-render.js";

export interface FloorplanDeps {
  hasMagick: () => Promise<boolean>;
  imageSize: (file: string) => Promise<{ width: number; height: number } | null>;
  fitImage: (file: string, width: number, height: number) => Promise<void>;
  compositePreview: (picture: string, overlayPng: string, out: string) => Promise<void>;
  maskToFootprint: (picture: string, maskPng: string, out: string) => Promise<void>;
}
export const realFloorplanDeps: FloorplanDeps = { hasMagick, imageSize, fitImage, compositePreview, maskToFootprint };

/** What an image job carries to turn the finished pictures into a scene. */
export interface FloorplanApply {
  to: "floorplanScene";
  plan: Floorplan;
  floors: FloorGeometry[];
  stairs: PlacedStair[];
  footprint: Array<{ x: number; y: number; w: number; h: number }>;
  /** One overlay PNG per floor (the alignment preview is made from it). */
  overlayPaths: string[];
  /** Local picture files: one per floor in order, and the roof picture (not yet masked). */
  pictures: { floors: string[]; roof?: string };
  /** The roof footprint guide; it doubles as the roof's transparency mask. */
  roofGuidePath?: string;
}

const FLOOR_HEIGHT = 10;
const OCCLUSION_FADE = 1;
const OCCLUSION_VISION = 8;

const fail = (code: "VALIDATION" | "INTERNAL" | "UNSUPPORTED", message: string, steps: string[]): ToolOutcome => ({ ok: false, error: { code, message }, steps });

export async function finishFloorplan(
  input: { apply: FloorplanApply; source: "data" | "forgevtt"; target: string; deps?: FloorplanDeps },
  transport: RelayTransport,
  opts: PipelineOptions,
): Promise<ToolOutcome> {
  const { apply, source, target } = input;
  const deps = input.deps ?? realFloorplanDeps;
  const { plan } = apply;
  const width = plan.cols * plan.pxPerCell;
  const height = plan.rows * plan.pxPerCell;
  const steps = ["generate"];
  const warnings: string[] = [];
  const sizeNote = `${width}x${height}`;

  const magick = await deps.hasMagick();
  if (!magick) {
    warnings.push(`ImageMagick (magick) was not found: the pictures were not checked or resized, and no previews were made; if a picture is not ${sizeNote} the walls will not line up`);
  }

  /** Resize a picture that is not exactly the scene size, so the walls land on the grid. */
  const fit = async (file: string, label: string) => {
    if (!magick) return;
    const before = await deps.imageSize(file);
    if (before && (before.width !== width || before.height !== height)) {
      await deps.fitImage(file, width, height);
      warnings.push(`the ${label} picture was ${before.width}x${before.height} and was resized to ${sizeNote} so the walls land on the grid`);
      if (!steps.includes("fit")) steps.push("fit");
    }
  };

  const upload = async (file: string, label: string): Promise<ToolOutcome & { path?: string }> => {
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (e) {
      return fail("INTERNAL", `Cannot read the picture ${file}: ${(e as Error).message}`, steps);
    }
    const ext = extname(file).toLowerCase() === ".webp" ? ".webp" : ".png";
    const out = await runUploadAsset(
      transport,
      { source, target, filename: `floorplan-${showImageFilename(`${plan.name} ${label}`, ext)}`, contentBase64: bytes.toString("base64"), mimeType: ext === ".webp" ? "image/webp" : "image/png" },
      opts,
    );
    return out.ok ? { ...out, path: (out.data as { path: string }).path } : { ...out, steps: [...steps, ...out.steps] };
  };

  // Pictures: fit every floor, fit and mask the roof.
  for (let i = 0; i < apply.pictures.floors.length; i++) await fit(apply.pictures.floors[i]!, apply.floors[i]!.name);
  let roofFile: string | undefined;
  if (apply.pictures.roof) {
    if (!magick) {
      warnings.push("the roof was skipped: it needs ImageMagick to be masked to the outline of the house");
    } else {
      await fit(apply.pictures.roof, "roof");
      roofFile = apply.pictures.roof.replace(/\.[a-z0-9]+$/i, "-masked.webp");
      await deps.maskToFootprint(apply.pictures.roof, apply.roofGuidePath!, roofFile);
      steps.push("mask");
    }
  }

  steps.push("upload");
  const floorSrcs: string[] = [];
  for (let i = 0; i < apply.pictures.floors.length; i++) {
    const up = await upload(apply.pictures.floors[i]!, apply.floors[i]!.name);
    if (!up.ok) return up;
    floorSrcs.push(up.path!);
  }
  let roofSrc: string | undefined;
  if (roofFile) {
    const up = await upload(roofFile, "roof");
    if (!up.ok) return up;
    roofSrc = up.path!;
  }

  steps.push("scene");
  const scene = await runCreateScene(transport, { name: plan.name, width, height, gridSize: plan.pxPerCell, gridDistance: plan.feetPerCell, background: floorSrcs[0] } as never, opts);
  if (!scene.ok) return { ...scene, steps: [...steps, ...scene.steps] };
  const sceneId = (scene.data as { _id: string })._id;
  const vision = await runUpdateDocument(transport, { documentType: "Scene", id: sceneId, data: { tokenVision: true } } as never, opts);
  if (!vision.ok) return { ...vision, steps: [...steps, ...vision.steps] };

  // Levels: the scene's own level becomes floor 0, the others are created above it.
  steps.push("levels");
  const found = await runFindDocuments(transport, { documentType: "Scene", id: sceneId, fields: ["_id", "levels"] }, opts);
  if (!found.ok) return { ...found, steps: [...steps, ...found.steps] };
  const first = ((found.data as { levels?: Array<{ _id: string }> }).levels ?? [])[0];
  if (!first) return fail("INTERNAL", "The new scene has no level: Foundry 14 is required for floors and the roof", steps);
  const levelIds = [first._id];
  const ground = await runUpdateEmbedded(
    transport,
    { parentType: "Scene", parentId: sceneId, embeddedName: "Level", data: [{ _id: first._id, name: apply.floors[0]!.name, "elevation.bottom": 0, "elevation.top": FLOOR_HEIGHT, "background.src": floorSrcs[0]!, sort: 0 }] },
    opts,
  );
  if (!ground.ok) return { ...ground, steps: [...steps, ...ground.steps] };
  if (apply.floors.length > 1) {
    const created = await runCreateEmbedded(
      transport,
      {
        parentType: "Scene",
        parentId: sceneId,
        embeddedName: "Level",
        data: apply.floors.slice(1).map((f, k) => ({ name: f.name, sort: k + 1, elevation: { bottom: FLOOR_HEIGHT * (k + 1), top: FLOOR_HEIGHT * (k + 2) }, background: { src: floorSrcs[k + 1]! } })),
        fields: ["_id", "name"],
      } as never,
      opts,
    );
    if (!created.ok) return { ...created, steps: [...steps, ...created.steps] };
    for (const d of created.data as Array<{ _id: string }>) levelIds.push(d._id);
  }

  // Walls and lights, floor by floor.
  for (let i = 0; i < apply.floors.length; i++) {
    const f = apply.floors[i]!;
    steps.push(`walls:${f.name}`);
    const walls = await runAddWalls(
      transport,
      { sceneId, levels: [levelIds[i]!], walls: f.walls.map((w) => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, kind: w.kind, ...w.doorOptions })) } as never,
      opts,
    );
    if (!walls.ok) return { ...walls, steps: [...steps, ...walls.steps] };
    if (f.lights.length) {
      const lights = await runAddLights(
        transport,
        { sceneId, levels: [levelIds[i]!], lights: f.lights.map((l) => ({ col: l.col, row: l.row, source: l.source, bright: l.bright, dim: l.dim, color: l.color ?? undefined, animation: l.animation.type ?? undefined })) } as never,
        opts,
      );
      if (!lights.ok) return { ...lights, steps: [...steps, ...lights.steps] };
    }
  }

  // Stairs and roof are placed in pixels, so they need the grid origin Foundry applied.
  const grid = await loadGrid(transport, sceneId, opts);
  if (isOutcome(grid)) return { ...grid, steps: [...steps, ...grid.steps] };
  const { size, origin } = grid;

  if (apply.stairs.length) {
    steps.push("stairs");
    const regions = await runCreateEmbedded(
      transport,
      {
        parentType: "Scene",
        parentId: sceneId,
        embeddedName: "Region",
        data: apply.stairs.map((s, i) => {
          const at = gridToPixels(s.x, s.y, size, origin);
          return {
            name: `Stairs ${i + 1}`,
            color: "#e6be3c",
            shapes: [{ type: "rectangle", x: at.x, y: at.y, width: s.w * size, height: s.h * size, rotation: 0, hole: false }],
            levels: [levelIds[s.from]!, levelIds[s.to]!],
            elevation: { bottom: FLOOR_HEIGHT * s.from, top: FLOOR_HEIGHT * (s.to + 1) },
            behaviors: [{ type: "changeLevel", name: "Change level", system: { movementActions: ["walk"] } }],
          };
        }),
        fields: ["_id"],
      } as never,
      opts,
    );
    if (!regions.ok) return { ...regions, steps: [...steps, ...regions.steps] };
  }

  let roof: { tileId: string; src: string } | null = null;
  if (roofSrc) {
    steps.push("roof");
    const at = gridToPixels(0, 0, size, origin);
    const tile = await runCreateEmbedded(
      transport,
      {
        parentType: "Scene",
        parentId: sceneId,
        embeddedName: "Tile",
        data: [
          {
            name: `${plan.name} roof`,
            x: at.x,
            y: at.y,
            width,
            height,
            elevation: FLOOR_HEIGHT * apply.floors.length,
            levels: levelIds,
            texture: { src: roofSrc },
            occlusion: { modes: [OCCLUSION_FADE, OCCLUSION_VISION], alpha: 0 },
          },
        ],
        fields: ["_id"],
      } as never,
      opts,
    );
    if (!tile.ok) return { ...tile, steps: [...steps, ...tile.steps] };
    roof = { tileId: (tile.data as Array<{ _id: string }>)[0]!._id, src: roofSrc };
  }

  const previews: string[] = [];
  if (magick) {
    for (let i = 0; i < apply.floors.length; i++) {
      const out = apply.overlayPaths[i]!.replace(/overlay-/, "preview-");
      try {
        await deps.compositePreview(apply.pictures.floors[i]!, apply.overlayPaths[i]!, out);
        previews.push(out);
      } catch (e) {
        warnings.push(`the alignment preview of ${apply.floors[i]!.name} could not be made: ${(e as Error).message}`);
      }
    }
    if (previews.length) steps.push("preview");
  }

  const wallCount = apply.floors.reduce((n, f) => n + f.walls.length, 0);
  const lightCount = apply.floors.reduce((n, f) => n + f.lights.length, 0);
  return {
    ok: true,
    data: {
      sceneId,
      src: floorSrcs[0],
      levels: apply.floors.map((f, i) => ({ id: levelIds[i]!, name: f.name })),
      stairs: apply.stairs.length,
      roof,
      overlays: apply.overlayPaths,
      previews,
      walls: wallCount,
      lights: lightCount,
      warnings,
    },
    steps,
  };
}
