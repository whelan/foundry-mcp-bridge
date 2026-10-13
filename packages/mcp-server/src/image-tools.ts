/**
 * generate_image / check_image_job / cancel_image_job. A request starts a Codex job
 * (see image-gen.ts); once the file exists it is uploaded to Foundry and, if asked,
 * applied (actor portrait, token art, item image, scene background, a new scene or a
 * journal page) through the ordinary document pipelines, so those writes are verified,
 * logged and undoable like any other.
 */

import { basename, join } from "node:path";
import { z } from "zod";
import type { RelayTransport } from "./relay-transport.js";
import {
  KIND_PRESETS,
  ImageJobs,
  buildImagePrompt,
  pngSize,
  readImageBytes,
  type ImageJob,
  type ImageKind,
} from "./image-gen.js";
import {
  runCreateScene,
  runFindDocuments,
  runShowImageFile,
  runUpdateDocument,
  runUpdateEmbedded,
  runUploadAsset,
  showImageFilename,
} from "./tools.js";
import type { PipelineOptions, ToolOutcome } from "./reliability.js";
import { ensureSceneBackground } from "./scene-background.js";
import { finishFloorplan, type FloorplanApply, type FloorplanDeps } from "./floorplan-finish.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_KINDS = ["portrait", "token", "battlemap", "handout", "item"] as const satisfies readonly ImageKind[];

const id = z.string().min(1);

const ApplySchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("actor"), id, alsoToken: z.boolean().optional().describe("Also use it as the actor's prototype token image") }),
  z.object({ to: z.literal("actorToken"), id }),
  z.object({ to: z.literal("item"), id }),
  z.object({
    to: z.literal("sceneBackground"),
    id,
    levelId: id.optional().describe("V14 scenes with several levels: which level's background to replace"),
  }),
  z.object({
    to: z.literal("newScene"),
    name: id,
    gridSize: z.number().int().positive().optional().describe("Grid square in pixels (default 100); the scene is as large as the image"),
    gridDistance: z.number().positive().optional(),
    gridUnits: z.string().optional(),
  }),
  z.object({
    to: z.literal("journal"),
    title: id,
    journal: id.default("Generated Art"),
  }),
]);
export type ImageApply = z.infer<typeof ApplySchema> | FloorplanApply;
type PublicApply = z.infer<typeof ApplySchema>;

export const GenerateImageShape = {
  prompt: z.string().min(3).describe("What to draw (the kind adds the style: portrait, token, battlemap, handout or item)"),
  kind: z.enum(IMAGE_KINDS).default("portrait"),
  width: z.number().int().min(256).max(4096).optional().describe("Size hint in pixels; Codex treats it as a hint"),
  height: z.number().int().min(256).max(4096).optional(),
  apply: ApplySchema.optional().describe("What to do with the image in Foundry once it exists; omit to only upload it"),
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1).default("generated-images").describe("Foundry directory the image is uploaded to"),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(600)
    .default(90)
    .describe("How long to wait for the image before returning a jobId to poll with check_image_job"),
};
export type GenerateImageArgs = z.input<z.ZodObject<typeof GenerateImageShape>>;

export const CheckImageJobShape = {
  jobId: id,
  waitSeconds: z.number().int().min(0).max(600).default(60),
};
export type CheckImageJobArgs = z.input<z.ZodObject<typeof CheckImageJobShape>>;

export const CancelImageJobShape = { jobId: id };

/** What a job carries from the request to its follow-up. */
export interface ImageJobMeta {
  kind: ImageKind;
  subject: string;
  apply?: ImageApply;
  source: "data" | "forgevtt";
  target: string;
}
export type ImageJobRegistry = ImageJobs<ImageJobMeta>;

const failWith = (
  code: "VALIDATION" | "NOT_FOUND" | "UNSUPPORTED" | "INTERNAL" | "TIMEOUT" | "CONFLICT",
  message: string,
  steps: string[] = [],
): ToolOutcome => ({ ok: false, error: { code, message }, steps });

const idOf = (data: unknown) => (data as { _id?: string })._id;

/** Upload, then apply. Returns the final result; throws nothing (failures become outcomes). */
async function followUp(
  job: ImageJob<ImageJobMeta>,
  transport: RelayTransport,
  opts: PipelineOptions,
  deps?: FloorplanDeps,
): Promise<ToolOutcome> {
  const { apply, kind, subject, source, target } = job.meta;
  const steps = ["generate"];
  const file = job.request.outPath;
  if (apply?.to === "floorplanScene") {
    return finishFloorplan({ apply, source, target, deps }, transport, opts);
  }
  const result = (src: string, applied?: unknown): ToolOutcome => ({
    ok: true,
    data: { jobId: job.id, status: "done", file, src, ...(applied ? { applied } : {}) },
    steps,
  });

  // A journal page is filed (hidden) by the existing show-image flow, which uploads the file itself.
  if (apply?.to === "journal") {
    steps.push("journal");
    const out = await runShowImageFile(
      transport,
      { filePath: file, title: apply.title, journal: apply.journal, target, source, show: false },
      opts,
    );
    if (!out.ok) return { ...out, steps: [...steps, ...out.steps] };
    const data = out.data as { src: string };
    return result(data.src, { to: "journal", ...(out.data as object) });
  }

  let bytes: Buffer;
  try {
    bytes = await readImageBytes(file, MAX_IMAGE_BYTES);
  } catch (e) {
    return failWith("INTERNAL", `Cannot read the generated image ${file}: ${(e as Error).message}`, steps);
  }
  steps.push("upload");
  const uploaded = await runUploadAsset(
    transport,
    { source, target, filename: `${kind}-${showImageFilename(subject, ".png")}`, contentBase64: bytes.toString("base64"), mimeType: "image/png" },
    opts,
  );
  if (!uploaded.ok) return { ...uploaded, steps: [...steps, ...uploaded.steps] };
  const src = (uploaded.data as { path: string }).path;
  if (!apply) return result(src);

  steps.push("apply");
  const done = (out: ToolOutcome, extra: object = {}): ToolOutcome =>
    out.ok ? result(src, { to: apply.to, ...extra, id: idOf(out.data) }) : { ...out, steps: [...steps, ...out.steps] };

  switch (apply.to) {
    case "actor":
      return done(
        await runUpdateDocument(
          transport,
          { documentType: "Actor", id: apply.id, data: { img: src, ...(apply.alsoToken ? { "prototypeToken.texture.src": src } : {}) } },
          opts,
        ),
      );
    case "actorToken":
      return done(await runUpdateDocument(transport, { documentType: "Actor", id: apply.id, data: { "prototypeToken.texture.src": src } }, opts));
    case "item":
      return done(await runUpdateDocument(transport, { documentType: "Item", id: apply.id, data: { img: src } }, opts));
    case "sceneBackground":
      return done(await applySceneBackground(transport, apply, src, opts));
    case "newScene": {
      const size = pngSize(bytes);
      if (!size) return failWith("VALIDATION", "A new scene needs the image size and only PNG sizes can be read", steps);
      const created = await runCreateScene(
        transport,
        { name: apply.name, width: size.width, height: size.height, gridSize: apply.gridSize ?? 100, gridDistance: apply.gridDistance, gridUnits: apply.gridUnits, background: src },
        opts,
      );
      if (created.ok) {
        const bg = await ensureSceneBackground(transport, idOf(created.data)!, src, opts);
        if (bg && !bg.ok) return { ...bg, steps: [...steps, ...bg.steps] };
      }
      return done(created, { width: size.width, height: size.height });
    }
  }
}

/** V13 keeps the background on the scene; V14 keeps it on its level(s). */
async function applySceneBackground(
  transport: RelayTransport,
  apply: Extract<PublicApply, { to: "sceneBackground" }>,
  src: string,
  opts: PipelineOptions,
): Promise<ToolOutcome> {
  const scene = await runFindDocuments(transport, { documentType: "Scene", id: apply.id, fields: ["_id", "levels"] }, opts);
  if (!scene.ok) return scene;
  const levels = ((scene.data as { levels?: Array<{ _id: string; name?: string }> }).levels ?? []).filter((l) => l._id);
  if (levels.length === 0) {
    return runUpdateDocument(transport, { documentType: "Scene", id: apply.id, data: { "background.src": src } }, opts);
  }
  const level = apply.levelId ? levels.find((l) => l._id === apply.levelId) : levels.length === 1 ? levels[0] : undefined;
  if (!level) {
    const list = levels.map((l) => `${l._id}${l.name ? ` (${l.name})` : ""}`).join(", ");
    return failWith("VALIDATION", `Scene ${apply.id} has levels: ${list}. Pass levelId to choose which background to replace.`);
  }
  return runUpdateEmbedded(
    transport,
    { parentType: "Scene", parentId: apply.id, embeddedName: "Level", data: [{ _id: level._id, "background.src": src }] },
    opts,
  );
}

/** Report where a job is; upload/apply the image the first time we see it finished. */
export async function settleJob(
  job: ImageJob<ImageJobMeta>,
  transport: RelayTransport,
  opts: PipelineOptions,
  deps?: FloorplanDeps,
): Promise<ToolOutcome> {
  switch (job.status) {
    case "running":
      return {
        ok: true,
        data: {
          jobId: job.id,
          status: "running",
          elapsedSeconds: Math.round((Date.now() - job.startedAt) / 1000),
          next: "Call check_image_job with this jobId; image generation takes a minute or more.",
        },
        steps: ["generate"],
      };
    case "cancelled":
      return { ok: true, data: { jobId: job.id, status: "cancelled" }, steps: ["generate"] };
    case "failed":
      return failWith(job.error?.code ?? "INTERNAL", job.error?.message ?? "Image generation failed", ["generate"]);
    case "done": {
      if (job.followUp) return job.followUp as ToolOutcome;
      job.pending ??= followUp(job, transport, opts, deps).finally(() => {
        job.pending = undefined;
      });
      const out = (await job.pending) as ToolOutcome;
      // Only a success is cached: a failed upload/apply can be retried by polling again.
      if (out.ok) job.followUp = out;
      return out;
    }
  }
}

export async function runGenerateImage(
  jobs: ImageJobRegistry,
  outputDir: string,
  transport: RelayTransport,
  args: GenerateImageArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const parsed = z.object(GenerateImageShape).parse(args);
  const preset = KIND_PRESETS[parsed.kind];
  const request = {
    prompt: buildImagePrompt(parsed.kind, parsed.prompt),
    width: parsed.width ?? preset.size[0],
    height: parsed.height ?? preset.size[1],
    outPath: join(outputDir, `${parsed.kind}-${showImageFilename(parsed.prompt, ".png")}`),
  };
  const job = jobs.start(request, { kind: parsed.kind, subject: parsed.prompt, apply: parsed.apply, source: parsed.source, target: parsed.target });
  if (!job) return failWith("CONFLICT", "Two images are already being generated; wait for one to finish or cancel it (cancel_image_job).");
  const current = (await jobs.wait(job.id, parsed.waitSeconds * 1000)) ?? job;
  return settleJob(current, transport, opts);
}

export async function runCheckImageJob(
  jobs: ImageJobRegistry,
  transport: RelayTransport,
  args: CheckImageJobArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const parsed = z.object(CheckImageJobShape).parse(args);
  const job = await jobs.wait(parsed.jobId, parsed.waitSeconds * 1000);
  if (!job) return failWith("NOT_FOUND", `No image job ${parsed.jobId} (jobs are forgotten when the MCP server restarts)`);
  return settleJob(job, transport, opts);
}

export function runCancelImageJob(jobs: ImageJobRegistry, args: { jobId: string }): ToolOutcome {
  const job = jobs.cancel(args.jobId);
  if (!job) return failWith("NOT_FOUND", `No image job ${args.jobId}`);
  return { ok: true, data: { jobId: job.id, status: job.status, file: basename(job.request.outPath) }, steps: ["cancel"] };
}
