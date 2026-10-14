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
  /** Local picture files, one per floor in order. */
  pictures: { floors: string[] };
  /** One entry per roof (the default roof and each wing): its picture (not yet masked), its transparency mask, and the top floor it sits on. */
  roofs?: Array<{ name: string; explicit: boolean; top: number; picture: string; maskPath: string }>;
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
  const roofFiles: Array<{ name: string; explicit: boolean; top: number; file: string }> = [];
  for (const r of apply.roofs ?? []) {
    if (!magick) {
      warnings.push(`the ${r.explicit ? `${r.name} ` : ""}roof was skipped: it needs ImageMagick to be masked to the outline of the house`);
      continue;
    }
    await fit(r.picture, r.explicit ? `${r.name} roof` : "roof");
    const file = r.picture.replace(/\.[a-z0-9]+$/i, "-masked.webp");
    await deps.maskToFootprint(r.picture, r.maskPath, file);
    if (!steps.includes("mask")) steps.push("mask");
    roofFiles.push({ name: r.name, explicit: r.explicit, top: r.top, file });
  }

  steps.push("upload");
  const floorSrcs: string[] = [];
  for (let i = 0; i < apply.pictures.floors.length; i++) {
    const up = await upload(apply.pictures.floors[i]!, apply.floors[i]!.name);
    if (!up.ok) return up;
    floorSrcs.push(up.path!);
  }
  const roofSrcs: Array<{ name: string; explicit: boolean; top: number; src: string }> = [];
  for (const r of roofFiles) {
    const up = await upload(r.file, r.explicit ? `roof ${r.name}` : "roof");
    if (!up.ok) return up;
    roofSrcs.push({ name: r.name, explicit: r.explicit, top: r.top, src: up.path! });
  }

  steps.push("scene");
  const scene = await runCreateScene(transport, { name: plan.name, width, height, gridSize: plan.pxPerCell, gridDistance: plan.feetPerCell, background: floorSrcs[plan.groundFloor] } as never, opts);
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
    { parentType: "Scene", parentId: sceneId, embeddedName: "Level", data: [{ _id: first._id, name: apply.floors[0]!.name, "elevation.bottom": FLOOR_HEIGHT * (0 - plan.groundFloor), "elevation.top": FLOOR_HEIGHT * (1 - plan.groundFloor), "background.src": floorSrcs[0]!, sort: 0 }] },
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
        data: apply.floors.slice(1).map((f, k) => ({ name: f.name, sort: k + 1, elevation: { bottom: FLOOR_HEIGHT * (k + 1 - plan.groundFloor), top: FLOOR_HEIGHT * (k + 2 - plan.groundFloor) }, background: { src: floorSrcs[k + 1]! } })),
        fields: ["_id", "sort"],
      } as never,
      opts,
    );
    if (!created.ok) return { ...created, steps: [...steps, ...created.steps] };
    // Foundry 14 does not return created documents in the order they were sent, so match each level by its sort.
    const bySort = new Map((created.data as Array<{ _id: string; sort: number }>).map((d) => [d.sort, d._id]));
    for (let k = 1; k < apply.floors.length; k++) {
      const id = bySort.get(k);
      if (!id) return fail("INTERNAL", `Foundry did not return the level for ${apply.floors[k]!.name}`, steps);
      levelIds.push(id);
    }
  }
  // The scene opens on its initial level, which is otherwise the first level made: the deepest cellar.
  const initial = await runUpdateDocument(transport, { documentType: "Scene", id: sceneId, data: { initialLevel: levelIds[plan.groundFloor]! } } as never, opts);
  if (!initial.ok) return { ...initial, steps: [...steps, ...initial.steps] };

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
        { sceneId, levels: [levelIds[i]!], elevation: FLOOR_HEIGHT * (i - plan.groundFloor), lights: f.lights.map((l) => ({ col: l.col, row: l.row, source: l.source, bright: l.bright, dim: l.dim, color: l.color ?? undefined, animation: l.animation.type ?? undefined })) } as never,
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
            elevation: { bottom: FLOOR_HEIGHT * (s.from - plan.groundFloor), top: FLOOR_HEIGHT * (s.to + 1 - plan.groundFloor) },
            behaviors: [{ type: "changeLevel", name: "Change level", system: { movementActions: ["walk"] } }],
          };
        }),
        fields: ["_id"],
      } as never,
      opts,
    );
    if (!regions.ok) return { ...regions, steps: [...steps, ...regions.steps] };
  }

  const roofs: Array<{ name: string; tileId: string; src: string }> = [];
  if (roofSrcs.length) {
    steps.push("roof");
    const at = gridToPixels(0, 0, size, origin);
    const multi = roofSrcs.length > 1;
    // One scene-size tile per roof, each sitting on top of the highest floor under it and seen from every level up to it.
    const tiles = await runCreateEmbedded(
      transport,
      {
        parentType: "Scene",
        parentId: sceneId,
        embeddedName: "Tile",
        data: roofSrcs.map((r) => ({
          name: multi ? `${plan.name} roof: ${r.name}` : `${plan.name} roof`,
          x: at.x,
          y: at.y,
          width,
          height,
          elevation: FLOOR_HEIGHT * (r.top + 1 - plan.groundFloor),
          levels: levelIds.slice(plan.groundFloor, r.top + 1),
          texture: { src: r.src, anchorX: 0, anchorY: 0 },
          occlusion: { modes: [OCCLUSION_FADE, OCCLUSION_VISION], alpha: 0 },
        })),
        fields: ["_id", "name"],
      } as never,
      opts,
    );
    if (!tiles.ok) return { ...tiles, steps: [...steps, ...tiles.steps] };
    // Matched by name, not position: Foundry 14 may return the tiles in another order.
    const tileByName = new Map((tiles.data as Array<{ _id: string; name: string }>).map((t) => [t.name, t._id]));
    for (const r of roofSrcs) roofs.push({ name: r.name, tileId: tileByName.get(multi ? `${plan.name} roof: ${r.name}` : `${plan.name} roof`)!, src: r.src });
  }
  const roof = roofs[0] ? { tileId: roofs[0].tileId, src: roofs[0].src } : null;

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
      src: floorSrcs[plan.groundFloor],
      levels: apply.floors.map((f, i) => ({ id: levelIds[i]!, name: f.name })),
      groundFloor: plan.groundFloor,
      stairs: apply.stairs.length,
      roof,
      roofs,
      overlays: apply.overlayPaths,
      previews,
      walls: wallCount,
      lights: lightCount,
      warnings,
    },
    steps,
  };
}
