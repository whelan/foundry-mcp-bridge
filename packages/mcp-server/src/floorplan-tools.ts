import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { FloorplanBaseSchema, FloorplanSchema, buildGeometry, type Floorplan, type PlacedStair } from "@foundry-mcp-bridge/shared";
import type { PipelineOptions, ToolOutcome } from "./reliability.js";
import type { RelayTransport } from "./relay-transport.js";
import { runGetWorldInfo, showImageFilename } from "./tools.js";
import { renderGuide, renderOverlay, renderRoofGuide } from "./floorplan-render.js";
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

const OPPOSITE = { n: "south", e: "west", s: "north", w: "east" } as const;
const COMPASS = { n: "north", e: "east", s: "south", w: "west" } as const;

export function buildFloorplanPrompt(plan: Floorplan, floor = 0, stairs: PlacedStair[] = []): string {
  const f = plan.floors[floor]!;
  const rooms = f.rooms
    .map((r) => `- ${r.name ?? r.id}: ${r.floor ? `${r.floor} floor, ` : ""}furnished with ${r.furnishings.length ? r.furnishings.join(", ") : "a few plain furnishings"}`)
    .join("\n");
  const multi = plan.floors.length > 1;
  const stairText = stairs
    .map((s) => {
      if (s.from === floor) return `The yellow area with treads is a staircase leading up: paint a wooden staircase climbing toward the ${COMPASS[s.dir]} side.`;
      if (s.to === floor) return `The yellow area is the top of a staircase coming up from below: paint the stair opening with a balustrade, the stairs descending toward the ${OPPOSITE[s.dir]} side.`;
      return "";
    })
    .filter(Boolean)
    .join(" ");
  return (
    `Paint a ${plan.style}${multi ? ` (this is the ${f.name} of a ${plan.floors.length}-storey building)` : ""} as a strictly top-down orthographic floorplan for a tabletop RPG map, exactly over the attached blueprint. ` +
    "Keep every wall, doorway and window exactly where the blueprint has it, and keep the image the same size and proportions. " +
    "Brown bars are doors, light-blue bars are windows (draw glass), the green area outside is grass or ground.\n\n" +
    (stairText ? `${stairText}\n\n` : "") +
    `Rooms:\n${rooms}\n\n` +
    "Light sources (fireplaces, torches, candles) must look lit. No grid lines, no text, no labels, no characters or creatures, no UI."
  );
}

export function buildRoofPrompt(plan: Floorplan): string {
  return (
    `Paint the ${plan.roofStyle} of a ${plan.style} as a strictly top-down orthographic view for a tabletop RPG map, exactly filling the white shape in the attached guide. ` +
    "Keep the outline of the white shape exactly; everything black in the guide stays plain black. " +
    "Show the roof surface with ridge lines and weathering, a chimney above each fireplace, and nothing else: no walls, no interior, no ground, no grid lines, no text, no characters, no UI."
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
  let source: "data" | "forgevtt", target: string, waitSeconds: number, plan: Floorplan;
  try {
    const { source: s, target: t, waitSeconds: w, ...spec } = z.object(FloorplanSceneShape).parse(args);
    [source, target, waitSeconds] = [s, t, w];
    plan = FloorplanSchema.parse(spec);
  } catch (e) {
    if (e instanceof ZodError) return fail("VALIDATION", e.issues.map((i) => i.message).join("; "));
    throw e;
  }
  const geo = buildGeometry(plan);
  if (!geo.ok) return fail("VALIDATION", geo.errors.join("; "));

  // Door animation, levels and the roof are Foundry 14; on 13 the module would silently drop them.
  const info = await runGetWorldInfo(transport, {} as never, opts);
  const major = Number.parseInt(String(info.ok ? (info.data as { foundryVersion?: string }).foundryVersion ?? "" : ""), 10);
  if (Number.isFinite(major) && major < 14) return fail("UNSUPPORTED", `Animated doors, floors and the roof need Foundry 14 (this world runs ${major}). Use add_walls and add_lights directly.`);

  await mkdir(outputDir, { recursive: true });
  const stamp = showImageFilename(plan.name, "");
  const px = plan.pxPerCell;
  const floorGuides: string[] = [];
  const floorPictures: string[] = [];
  const overlayPaths: string[] = [];
  for (let i = 0; i < geo.floors.length; i++) {
    const f = geo.floors[i]!;
    const touching = geo.stairs.filter((st) => st.from === i || st.to === i);
    const guide = join(outputDir, `guide-${stamp}-f${i}.png`);
    const overlay = join(outputDir, `overlay-${stamp}-f${i}.png`);
    await writeFile(guide, renderGuide(plan, f.walls, { floor: i, stairs: touching }));
    await writeFile(overlay, renderOverlay(plan, f.walls, f.lights, touching));
    floorGuides.push(guide);
    overlayPaths.push(overlay);
    floorPictures.push(join(outputDir, `floorplan-${stamp}-f${i}.webp`));
  }
  let roofGuide: string | undefined;
  let roofPicture: string | undefined;
  if (plan.roof) {
    roofGuide = join(outputDir, `roof-guide-${stamp}.png`);
    roofPicture = join(outputDir, `roof-${stamp}.webp`);
    await writeFile(roofGuide, renderRoofGuide(plan, geo.footprint));
  }
  const apply: FloorplanApply = {
    to: "floorplanScene", plan, floors: geo.floors, stairs: geo.stairs, footprint: geo.footprint,
    overlayPaths,
    pictures: { floors: plan.codex ? floorPictures : floorGuides, roof: plan.codex ? roofPicture : roofGuide },
    roofGuidePath: roofGuide,
  };

  if (!plan.codex) return finishFloorplan({ apply, source, target, deps }, transport, opts);

  const seed = plan.seed ? `\n\nVariation seed: ${plan.seed}` : "";
  const parts = geo.floors.map((_, i) => ({
    prompt: buildFloorplanPrompt(plan, i, geo.stairs) + seed,
    width: plan.cols * px,
    height: plan.rows * px,
    outPath: floorPictures[i]!,
    guidePath: floorGuides[i]!,
  }));
  if (roofPicture && roofGuide) parts.push({ prompt: buildRoofPrompt(plan) + seed, width: plan.cols * px, height: plan.rows * px, outPath: roofPicture, guidePath: roofGuide });
  const job = jobs.start({ ...parts[0]!, parts }, { kind: "battlemap", subject: plan.name, apply, source, target });
  if (!job) return fail("CONFLICT", "Two images are already being generated; wait for one to finish or cancel it (cancel_image_job).");
  const current = (await jobs.wait(job.id, waitSeconds * 1000)) ?? job;
  return settleJob(current, transport, opts, deps);
}
