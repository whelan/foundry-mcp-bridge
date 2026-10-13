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
import { ensureSceneBackground } from "./scene-background.js";
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
  const background = await ensureSceneBackground(transport, sceneId, src, opts);
  if (background && !background.ok) return { ...background, steps: [...steps, ...background.steps] };

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
