/**
 * Image generation through the OpenAI Codex CLI, as background jobs. A Codex image takes
 * minutes — longer than an MCP client will wait on one call — so a request starts a job and
 * the caller polls it. The actual generation is `scripts/gen-image.mjs --backend codex`
 * (it drives `codex exec`, finds the file in Codex's cache and moves it where we want it);
 * this module only spawns that script, tracks the job and can cancel it.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type ImageKind = "portrait" | "token" | "battlemap" | "handout" | "item";

/** What each kind of art is for: a size hint (Codex treats it as one) and the style it needs. */
export const KIND_PRESETS: Record<ImageKind, { size: readonly [number, number]; style: string }> = {
  portrait: {
    size: [1024, 1024],
    style: "Fantasy RPG character portrait, head and shoulders, painterly, dramatic lighting. No text, no frame, no watermark.",
  },
  token: {
    size: [1024, 1024],
    style:
      "Fantasy RPG token art: the subject centered and filling the frame, viewed from the front, on a plain flat background. " +
      "No border, no text, no watermark.",
  },
  battlemap: {
    size: [1536, 1024],
    style:
      "Top-down battle map for a tabletop RPG: strictly orthographic bird's-eye view straight down, no perspective. " +
      "No grid lines, no text, no labels, no characters or creatures, no UI. Even lighting, edge to edge, painterly.",
  },
  handout: {
    size: [1024, 1536],
    style: "Illustration for a tabletop RPG handout, aged parchment look, hand-drawn. Any lettering must be minimal and legible.",
  },
  item: {
    size: [1024, 1024],
    style: "A single fantasy RPG item illustration, centered, on a plain flat background. No text, no hands, no watermark.",
  },
};

export function buildImagePrompt(kind: ImageKind, subject: string): string {
  return `${subject.trim()}\n\n${KIND_PRESETS[kind].style}`;
}

/** Width and height of a PNG from its IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// --- running one generation ------------------------------------------------------

export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
  /** Where the finished file must end up (absolute). */
  outPath: string;
  /** A local image Codex is shown alongside the prompt (a blueprint to paint over). */
  guidePath?: string;
}

export type ImageRunErrorCode = "UNSUPPORTED" | "INTERNAL" | "TIMEOUT";

export class ImageRunError extends Error {
  constructor(
    readonly code: ImageRunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageRunError";
  }
}

/** Produces the image file. Must reject promptly (and stop its work) when `signal` aborts. */
export type ImageRunner = (request: ImageRequest, signal: AbortSignal) => Promise<{ path: string }>;

export interface CodexRunnerConfig {
  /** The `codex` binary; an absolute path when the MCP client starts us with a minimal PATH. */
  codexBin: string;
  model?: string;
  timeoutMs: number;
  /** Override for tests. */
  script?: string;
  node?: string;
}

/** `packages/mcp-server/{src,dist}/` → repo `scripts/` (same depth either way). */
const DEFAULT_SCRIPT = fileURLToPath(new URL("../../../scripts/gen-image.mjs", import.meta.url));

export function buildGenImageArgs(request: ImageRequest, script: string, model?: string): string[] {
  return [
    script,
    "--backend", "codex",
    "--prompt", request.prompt,
    "--out", request.outPath,
    "--width", String(request.width),
    "--height", String(request.height),
    "--no-sidecar",
    ...(request.guidePath ? ["--image", request.guidePath] : []),
    ...(model ? ["--codex-model", model] : []),
  ];
}

const tail = (text: string, lines = 12) => text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");

/** Turn the script's stderr into an error that says what to do about it. */
export function explainGenImageFailure(output: string, codexBin: string): ImageRunError {
  if (/needs the OpenAI Codex CLI|ENOENT/.test(output)) {
    return new ImageRunError(
      "UNSUPPORTED",
      `The Codex CLI was not found (tried "${codexBin}"). Install it with \`npm i -g @openai/codex\`, run \`codex login\`, ` +
        "and set CODEX_BIN to its absolute path (e.g. /opt/homebrew/bin/codex) — an MCP client starts this server with a minimal PATH.",
    );
  }
  if (/log ?in|auth|credential|unauthori[sz]ed|api key/i.test(output)) {
    return new ImageRunError("UNSUPPORTED", `Codex is not signed in; run \`codex login\` in a terminal.\n${tail(output)}`);
  }
  if (/timed out/.test(output)) return new ImageRunError("TIMEOUT", tail(output));
  if (/ImageMagick|image converter/.test(output)) {
    return new ImageRunError("UNSUPPORTED", `${tail(output)}`);
  }
  return new ImageRunError("INTERNAL", `Image generation failed:\n${tail(output)}`);
}

export function createCodexRunner(config: CodexRunnerConfig): ImageRunner {
  return (request, signal) =>
    new Promise((resolve, reject) => {
      const script = config.script ?? DEFAULT_SCRIPT;
      const child = spawn(config.node ?? process.execPath, buildGenImageArgs(request, script, config.model), {
        env: { ...process.env, IMAGE_GEN_CODEX_BIN: config.codexBin, IMAGE_GEN_TIMEOUT_MS: String(config.timeoutMs) },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so cancelling also stops the `codex` the script started.
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      const stop = () => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // already gone
        }
      };
      const onAbort = () => {
        stop();
        reject(new ImageRunError("INTERNAL", "cancelled"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(new ImageRunError("INTERNAL", `Could not start the image script: ${e.message}`));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return;
        if (code !== 0) return reject(explainGenImageFailure(`${stderr}\n${stdout}`, config.codexBin));
        stat(request.outPath).then(
          () => resolve({ path: request.outPath }),
          () => reject(new ImageRunError("INTERNAL", `The script finished but wrote no file at ${request.outPath}`)),
        );
      });
    });
}

// --- job tracking -----------------------------------------------------------------

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface ImageJob<M> {
  id: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  request: ImageRequest;
  /** Caller context carried with the job (what to do with the image once it exists). */
  meta: M;
  error?: { code: ImageRunErrorCode; message: string };
  /** Cached result of the caller's follow-up (upload/apply), so polling twice does it once. */
  followUp?: unknown;
  /** The follow-up while it runs, so two polls at once share one upload instead of making two. */
  pending?: Promise<unknown>;
}

interface Tracked<M> {
  job: ImageJob<M>;
  abort: AbortController;
  settled: Promise<void>;
}

export class ImageJobs<M> {
  private readonly jobs = new Map<string, Tracked<M>>();

  constructor(
    private readonly runner: ImageRunner,
    private readonly limits: { maxRunning: number; keep: number } = { maxRunning: 2, keep: 20 },
  ) {}

  running(): number {
    return [...this.jobs.values()].filter((t) => t.job.status === "running").length;
  }

  /** Returns null when too many jobs are already running. */
  start(request: ImageRequest, meta: M): ImageJob<M> | null {
    if (this.running() >= this.limits.maxRunning) return null;
    const job: ImageJob<M> = { id: randomUUID().slice(0, 8), status: "running", startedAt: Date.now(), request, meta };
    const abort = new AbortController();
    const settled = this.runner(request, abort.signal).then(
      () => {
        if (job.status === "running") this.finish(job, "done");
      },
      (e: unknown) => {
        if (job.status !== "running") return; // cancelled meanwhile
        job.error =
          e instanceof ImageRunError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: (e as Error).message };
        this.finish(job, "failed");
      },
    );
    this.jobs.set(job.id, { job, abort, settled });
    this.trim();
    return job;
  }

  private finish(job: ImageJob<M>, status: JobStatus): void {
    job.status = status;
    job.finishedAt = Date.now();
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((t) => t.job.status !== "running");
    for (const t of finished.slice(0, Math.max(0, this.jobs.size - this.limits.keep))) this.jobs.delete(t.job.id);
  }

  get(id: string): ImageJob<M> | undefined {
    return this.jobs.get(id)?.job;
  }

  cancel(id: string): ImageJob<M> | undefined {
    const tracked = this.jobs.get(id);
    if (!tracked) return undefined;
    if (tracked.job.status === "running") {
      this.finish(tracked.job, "cancelled");
      tracked.abort.abort();
    }
    return tracked.job;
  }

  /** Resolves when the job leaves "running", or after `ms`, whichever is first. */
  async wait(id: string, ms: number): Promise<ImageJob<M> | undefined> {
    const tracked = this.jobs.get(id);
    if (!tracked) return undefined;
    if (tracked.job.status === "running" && ms > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([tracked.settled, new Promise((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
    }
    return tracked.job;
  }
}

export async function readImageBytes(path: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(path);
  if (info.size > maxBytes) throw new ImageRunError("INTERNAL", `Generated image is ${info.size} bytes; the limit is ${maxBytes}`);
  return readFile(path);
}
