import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import {
  ImageJobs,
  ImageRunError,
  buildGenImageArgs,
  buildImagePrompt,
  createCodexRunner,
  explainGenImageFailure,
  pngSize,
  type ImageRequest,
  type ImageRunner,
} from "../../packages/mcp-server/src/image-gen.js";
import {
  runCancelImageJob,
  runCheckImageJob,
  runGenerateImage,
  type ImageJobMeta,
} from "../../packages/mcp-server/src/image-tools.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";

/** A 33-byte stand-in with a valid PNG signature and IHDR size. */
function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const out = () => mkdtempSync(join(tmpdir(), "gen-image-"));

/** A runner that writes a PNG after `delayMs`, or never finishes until aborted. */
function stubRunner(options: { delayMs?: number; size?: [number, number]; fail?: ImageRunError; hang?: boolean } = {}) {
  const calls: ImageRequest[] = [];
  let aborted = 0;
  const runner: ImageRunner = (request, signal) =>
    new Promise((resolve, reject) => {
      calls.push(request);
      const onAbort = () => {
        aborted++;
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (options.hang) return;
      setTimeout(async () => {
        if (signal.aborted) return;
        if (options.fail) return reject(options.fail);
        await mkdir(dirname(request.outPath), { recursive: true });
        await writeFile(request.outPath, fakePng(...(options.size ?? [1536, 1024])));
        resolve({ path: request.outPath });
      }, options.delayMs ?? 0);
    });
  return { runner, calls, aborted: () => aborted };
}

function setup(runnerOptions: Parameters<typeof stubRunner>[0] = {}) {
  const mock = new MockFoundry();
  const transport = new MockTransport(mock);
  const stub = stubRunner(runnerOptions);
  const jobs = new ImageJobs<ImageJobMeta>(stub.runner);
  const dir = out();
  mock.store.set("!actors!a1", { _id: "a1", name: "Strahd", img: "old.webp", prototypeToken: { texture: { src: "old-token.webp" } } });
  mock.store.set("!items!i1", { _id: "i1", name: "Sunsword", img: "old-item.webp" });
  return { mock, transport, jobs, dir, ...stub };
}

const data = (o: ToolOutcome) => (o.ok ? (o.data as any) : null);
const code = (o: ToolOutcome) => (o.ok ? "ok" : o.error.code);

describe("generate_image", () => {
  it("generates, uploads and applies an actor portrait in one call", async () => {
    const { mock, transport, jobs, dir, calls } = setup();
    const res = await runGenerateImage(jobs, dir, transport, { prompt: "Count Strahd, brooding", kind: "portrait", apply: { to: "actor", id: "a1", alsoToken: true } });
    expect(res.ok).toBe(true);
    expect(res.steps).toEqual(expect.arrayContaining(["generate", "upload", "apply"]));
    const src = data(res).src as string;
    expect(src).toMatch(/^generated-images\/portrait-\d{8}-\d{6}-count-strahd-brooding\.png$/);
    expect(mock.filePicker.uploads.map((u) => u.path)).toEqual([src]);
    expect(mock.store.get("!actors!a1")).toMatchObject({ img: src, prototypeToken: { texture: { src } } });
    // the kind's style is part of the prompt, and the preset size is the default
    expect(calls[0]!.prompt).toContain("Count Strahd, brooding");
    expect(calls[0]!.prompt).toContain("character portrait");
    expect([calls[0]!.width, calls[0]!.height]).toEqual([1024, 1024]);
  });

  it("only uploads when there is nothing to apply", async () => {
    const { mock, transport, jobs, dir } = setup();
    const res = await runGenerateImage(jobs, dir, transport, { prompt: "a rusty key", kind: "item" });
    expect(res.ok && data(res).applied).toBeUndefined();
    expect(mock.filePicker.uploads).toHaveLength(1);
  });

  it("applies token art, item images and a battlemap-sized new scene", async () => {
    const { mock, transport, jobs, dir } = setup({ size: [1500, 1000] });
    const token = await runGenerateImage(jobs, dir, transport, { prompt: "wolf token", kind: "token", apply: { to: "actorToken", id: "a1" } });
    expect(mock.store.get("!actors!a1")).toMatchObject({ img: "old.webp", prototypeToken: { texture: { src: data(token).src } } });
    const item = await runGenerateImage(jobs, dir, transport, { prompt: "radiant sword", kind: "item", apply: { to: "item", id: "i1" } });
    expect(mock.store.get("!items!i1")).toMatchObject({ img: data(item).src });

    const scene = await runGenerateImage(jobs, dir, transport, { prompt: "a crypt", kind: "battlemap", apply: { to: "newScene", name: "Crypt" } });
    expect(scene.ok).toBe(true);
    const created = mock.documents("Scene").find((s) => s.name === "Crypt")!;
    expect(created).toMatchObject({ width: 1500, height: 1000, background: { src: data(scene).src }, grid: { size: 100 } });
  });

  it("files a hidden journal page without showing it to the players", async () => {
    const { mock, transport, jobs, dir } = setup();
    const res = await runGenerateImage(jobs, dir, transport, { prompt: "a sealed letter", kind: "handout", apply: { to: "journal", title: "The Letter" } });
    expect(res.ok).toBe(true);
    expect(mock.shownImages).toEqual([]);
    const journal = mock.documents("JournalEntry").find((j) => j.name === "Generated Art") as any;
    expect(journal.pages[0]).toMatchObject({ name: "The Letter", type: "image" });
  });

  describe("scene backgrounds across V13 and V14", () => {
    const sceneBackground = (id: string, levelId?: string) => ({ to: "sceneBackground" as const, id, ...(levelId ? { levelId } : {}) });

    it("V13: sets background.src on the scene", async () => {
      const { mock, transport, jobs, dir } = setup();
      mock.store.set("!scenes!s1", { _id: "s1", name: "Old", background: { src: "old.webp" } });
      const res = await runGenerateImage(jobs, dir, transport, { prompt: "x map", kind: "battlemap", apply: sceneBackground("s1") });
      expect(mock.store.get("!scenes!s1")).toMatchObject({ background: { src: data(res).src } });
    });

    it("V14 with one level: updates that level", async () => {
      const { mock, transport, jobs, dir } = setup();
      mock.store.set("!scenes!s1", { _id: "s1", name: "Old", levels: [{ _id: "l1", name: "Ground", background: { src: "old.webp" } }] });
      const res = await runGenerateImage(jobs, dir, transport, { prompt: "x map", kind: "battlemap", apply: sceneBackground("s1") });
      expect(res.ok).toBe(true);
      expect((mock.store.get("!scenes!s1") as any).levels[0]).toMatchObject({ background: { src: data(res).src } });
    });

    it("V14 with several levels: asks which one, and then uses it", async () => {
      const { mock, transport, jobs, dir } = setup();
      mock.store.set("!scenes!s1", { _id: "s1", name: "Old", levels: [{ _id: "l1", name: "Ground", background: {} }, { _id: "l2", name: "Cellar", background: {} }] });
      const ambiguous = await runGenerateImage(jobs, dir, transport, { prompt: "x map", kind: "battlemap", apply: sceneBackground("s1") });
      expect(code(ambiguous)).toBe("VALIDATION");
      expect(!ambiguous.ok && ambiguous.error.message).toContain("l2 (Cellar)");
      const res = await runGenerateImage(jobs, dir, transport, { prompt: "x map", kind: "battlemap", apply: sceneBackground("s1", "l2") });
      expect(res.ok).toBe(true);
      const levels = (mock.store.get("!scenes!s1") as any).levels;
      expect(levels[0].background).toEqual({});
      expect(levels[1].background.src).toBe(data(res).src);
    });
  });

  describe("jobs", () => {
    it("returns a jobId when the image is not ready, then finishes once however often it is polled", async () => {
      const { mock, transport, jobs, dir } = setup({ delayMs: 60 });
      const started = await runGenerateImage(jobs, dir, transport, { prompt: "slow art", kind: "portrait", apply: { to: "actor", id: "a1" }, waitSeconds: 0 });
      expect(data(started)).toMatchObject({ status: "running" });
      const jobId = data(started).jobId as string;
      expect(mock.filePicker.uploads).toHaveLength(0);

      const [a, b] = await Promise.all([
        runCheckImageJob(jobs, transport, { jobId, waitSeconds: 5 }),
        runCheckImageJob(jobs, transport, { jobId, waitSeconds: 5 }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      const again = await runCheckImageJob(jobs, transport, { jobId, waitSeconds: 0 });
      expect(data(again).src).toBe(data(a).src);
      expect(mock.filePicker.uploads).toHaveLength(1);
    });

    it("retries the upload/apply when it failed, without regenerating", async () => {
      const { mock, transport, jobs, dir, calls } = setup();
      mock.injectFailure({ result: { code: "INTERNAL", message: "upload broke" } });
      const first = await runGenerateImage(jobs, dir, transport, { prompt: "retry me", kind: "portrait", apply: { to: "actor", id: "a1" } });
      expect(code(first)).toBe("INTERNAL");
      const jobId = [...(jobs as any).jobs.keys()][0] as string;
      const second = await runCheckImageJob(jobs, transport, { jobId, waitSeconds: 0 });
      expect(second.ok).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it("cancels a running job and stops its process", async () => {
      const { transport, jobs, dir, aborted } = setup({ hang: true });
      const started = await runGenerateImage(jobs, dir, transport, { prompt: "never ends", kind: "portrait", waitSeconds: 0 });
      const jobId = data(started).jobId as string;
      expect(data(runCancelImageJob(jobs, { jobId }))).toMatchObject({ status: "cancelled" });
      expect(aborted()).toBe(1);
      const check = await runCheckImageJob(jobs, transport, { jobId, waitSeconds: 0 });
      expect(data(check)).toMatchObject({ status: "cancelled" });
      expect(code(runCancelImageJob(jobs, { jobId: "nope" }))).toBe("NOT_FOUND");
    });

    it("limits how many run at once", async () => {
      const { transport, jobs, dir } = setup({ hang: true });
      await runGenerateImage(jobs, dir, transport, { prompt: "one", kind: "portrait", waitSeconds: 0 });
      await runGenerateImage(jobs, dir, transport, { prompt: "two", kind: "portrait", waitSeconds: 0 });
      const third = await runGenerateImage(jobs, dir, transport, { prompt: "three", kind: "portrait", waitSeconds: 0 });
      expect(code(third)).toBe("CONFLICT");
    });

    it("reports a missing Codex CLI as UNSUPPORTED with the fix", async () => {
      const failure = explainGenImageFailure("gen-image: backend 'codex' needs the OpenAI Codex CLI (`codex`) on PATH", "codex");
      const { transport, jobs, dir } = setup({ fail: failure });
      const res = await runGenerateImage(jobs, dir, transport, { prompt: "a ghost", kind: "portrait" });
      expect(code(res)).toBe("UNSUPPORTED");
      expect(!res.ok && res.error.message).toMatch(/CODEX_BIN.*opt\/homebrew/s);
    });
  });
});

describe("prompt and size helpers", () => {
  it("adds the style of the kind", () => {
    expect(buildImagePrompt("battlemap", "a flooded crypt")).toMatch(/flooded crypt[\s\S]*top-down[\s\S]*No grid lines/i);
  });

  it("reads PNG sizes and rejects other bytes", () => {
    expect(pngSize(fakePng(1536, 1024))).toEqual({ width: 1536, height: 1024 });
    expect(pngSize(Buffer.from("RIFF....WEBP"))).toBeNull();
  });

  it("builds the gen-image invocation for the codex backend", () => {
    const args = buildGenImageArgs({ prompt: "p", width: 10, height: 20, outPath: "/o/x.png" }, "/s/gen-image.mjs", "gpt-x");
    expect(args).toEqual(["/s/gen-image.mjs", "--backend", "codex", "--prompt", "p", "--out", "/o/x.png", "--width", "10", "--height", "20", "--no-sidecar", "--codex-model", "gpt-x"]);
  });

  it("passes the guide image to gen-image", () => {
    const args = buildGenImageArgs({ prompt: "p", width: 10, height: 20, outPath: "/o/x.webp", guidePath: "/g/guide.png" }, "/s/gen-image.mjs");
    expect(args).toEqual(["/s/gen-image.mjs", "--backend", "codex", "--prompt", "p", "--out", "/o/x.webp", "--width", "10", "--height", "20", "--no-sidecar", "--image", "/g/guide.png"]);
  });

  it("explains failures", () => {
    expect(explainGenImageFailure("Error: not logged in, please login", "codex").message).toContain("codex login");
    expect(explainGenImageFailure("codex timed out after 300000ms", "codex").code).toBe("TIMEOUT");
    expect(explainGenImageFailure("something odd", "codex").code).toBe("INTERNAL");
  });
});

describe("the Codex runner process", () => {
  /** A stand-in for gen-image.mjs that behaves as told by the first extra env/args. */
  function fakeScript(body: string): string {
    const file = join(out(), "fake-gen-image.mjs");
    writeFileSync(file, body);
    return file;
  }
  const request = (): ImageRequest => ({ prompt: "p", width: 64, height: 64, outPath: join(out(), "img.png") });

  it("resolves with the file the script wrote and passes the configured binary through", async () => {
    const script = fakeScript(`
      import { writeFileSync } from "node:fs";
      const out = process.argv[process.argv.indexOf("--out") + 1];
      writeFileSync(out + ".bin", process.env.IMAGE_GEN_CODEX_BIN);
      writeFileSync(out, "png");
      console.log(JSON.stringify({ path: out }));
    `);
    const req = request();
    const result = await createCodexRunner({ codexBin: "/opt/homebrew/bin/codex", timeoutMs: 5000, script })(req, new AbortController().signal);
    expect(result.path).toBe(req.outPath);
    expect(existsSync(`${req.outPath}.bin`)).toBe(true);
  });

  it("turns a failing script into an explained error", async () => {
    const script = fakeScript(`console.error("gen-image: backend 'codex' needs the OpenAI Codex CLI (\`codex\`) on PATH"); process.exit(1);`);
    await expect(createCodexRunner({ codexBin: "codex", timeoutMs: 5000, script })(request(), new AbortController().signal)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("stops the process when aborted", async () => {
    const script = fakeScript(`setTimeout(() => {}, 60000);`);
    const controller = new AbortController();
    const started = Date.now();
    const run = createCodexRunner({ codexBin: "codex", timeoutMs: 5000, script })(request(), controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("ImageJobs with parts", () => {
  const mk = (n: string): ImageRequest => ({ prompt: n, width: 10, height: 10, outPath: `/x/${n}.webp` });

  it("runs the parts of one request in order as one job and fails the job when a part fails", async () => {
    const seen: string[] = [];
    const runner: ImageRunner = async (req) => {
      seen.push(req.outPath);
      if (req.outPath.endsWith("b.webp")) throw new ImageRunError("INTERNAL", "boom");
      return { path: req.outPath };
    };
    const jobs = new ImageJobs(runner);
    const ok = jobs.start({ ...mk("a"), parts: [mk("a"), mk("c")] }, {});
    await jobs.wait(ok!.id, 1000);
    expect(ok!.status).toBe("done");
    expect(seen).toEqual(["/x/a.webp", "/x/c.webp"]);
    seen.length = 0;
    const bad = jobs.start({ ...mk("a"), parts: [mk("a"), mk("b"), mk("c")] }, {});
    await jobs.wait(bad!.id, 1000);
    expect(bad!.status).toBe("failed");
    expect(bad!.error?.message).toBe("boom");
    expect(seen).toEqual(["/x/a.webp", "/x/b.webp"]);
  });

  it("a request without parts still runs once", async () => {
    const seen: string[] = [];
    const jobs = new ImageJobs(async (req) => (seen.push(req.outPath), { path: req.outPath }));
    const j = jobs.start(mk("solo"), {});
    await jobs.wait(j!.id, 1000);
    expect(seen).toEqual(["/x/solo.webp"]);
  });
});
