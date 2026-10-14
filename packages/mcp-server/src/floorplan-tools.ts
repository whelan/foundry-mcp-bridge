import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { FloorplanBaseSchema, FloorplanSchema, SURROUNDING_STYLE, buildGeometry, resolveConstruction, type Floorplan, type PlacedStair, type SurroundingFeature } from "@foundry-mcp-bridge/shared";
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

/** Where a rectangle sits in the picture, in words the painter can follow. */
export function describePlace(f: SurroundingFeature, cols: number, rows: number): string {
  const cx = (f.x + f.w / 2) / cols;
  const cy = (f.y + f.h / 2) / rows;
  const v = cy < 1 / 3 ? "north" : cy > 2 / 3 ? "south" : "";
  const h = cx < 1 / 3 ? "west" : cx > 2 / 3 ? "east" : "";
  const where = v || h ? `in the ${v}${v && h ? "-" : ""}${h} of the picture` : "in the middle of the picture";
  const run = f.w >= f.h * 2 ? "running east-west, " : f.h >= f.w * 2 ? "running north-south, " : "";
  return `${run}${where}`;
}

/** The paragraph about everything outside the walls (ground floor only). Empty when the plan has no surroundings. */
export function buildSurroundingsText(plan: Floorplan): string {
  const s = plan.surroundings;
  if (!s) return "";
  const lines = s.features.map((f) => {
    const st = SURROUNDING_STYLE[f.kind];
    return `- the ${st.colour} area is ${st.label}${f.note ? `: ${f.note}` : ""}, ${describePlace(f, plan.cols, plan.rows)}`;
  });
  return (
    `Surroundings: the open ground outside the house (the olive-green area of the blueprint) is ${s.ground}.` +
    (s.mood ? ` Mood: ${s.mood}.` : "") +
    (lines.length ? `\nThe coloured areas outside the house in the blueprint are landscape features; paint each one as described and keep its position and size:\n${lines.join("\n")}` : "") +
    "\nBlend the edges naturally; the house itself and its walls stay exactly where the blueprint has them."
  );
}

/** How the walls, doors and windows are built in this house, in words for the painter. */
export function buildConstructionText(plan: Floorplan): string {
  const c = resolveConstruction(plan);
  const ft = (n: number) => `${Math.round(n * 100) / 100} ft`;
  return (
    `Construction: the outer walls are about ${ft(c.exterior.thickness)} thick${c.exterior.material ? `, ${c.exterior.material}` : ""}; ` +
    `the walls between rooms are about ${ft(c.interior.thickness)} thick${c.interior.material ? `, ${c.interior.material}` : ""} and are clearly thinner than the outer walls: draw each dark bar of the blueprint at exactly its own thickness. ` +
    (c.doors.look ? `Doors: ${c.doors.look}. ` : "") +
    (c.windows.look ? `Windows: ${c.windows.look}. ` : "") +
    "Doors and windows are exactly as thick as the wall they sit in: never draw a door, frame, sill or pane wider than its wall."
  );
}

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
    `${buildConstructionText(plan)}\n\n` +
    (stairText ? `${stairText}\n\n` : "") +
    (floor === 0 && plan.surroundings ? `${buildSurroundingsText(plan)}\n\n` : "") +
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
