import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FloorplanBaseSchema, FloorplanSchema, buildGeometry, type Floorplan } from "@foundry-mcp-bridge/shared";
import type { PipelineOptions, ToolOutcome } from "./reliability.js";
import type { RelayTransport } from "./relay-transport.js";
import { runGetWorldInfo, showImageFilename } from "./tools.js";
import { renderGuide, renderOverlay } from "./floorplan-render.js";
import { finishFloorplan, realFloorplanDeps, type FloorplanApply, type FloorplanDeps } from "./floorplan-finish.js";
import type { ImageJobRegistry } from "./image-tools.js";
import { settleJob } from "./image-tools.js";

export const FloorplanSceneShape = {
  ...FloorplanBaseSchema.shape,
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1).default("generated-images").describe("Foundry directory the picture is uploaded to"),
  waitSeconds: z.number().int().min(0).max(600).default(90).describe("How long to wait for Codex before returning a jobId to poll with check_image_job"),
};
export type FloorplanSceneArgs = z.input<z.ZodObject<typeof FloorplanSceneShape>>;

const fail = (code: "VALIDATION" | "UNSUPPORTED" | "CONFLICT", message: string): ToolOutcome => ({ ok: false, error: { code, message }, steps: [] });

export function buildFloorplanPrompt(plan: Floorplan): string {
  const rooms = plan.floors[0]!.rooms
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
