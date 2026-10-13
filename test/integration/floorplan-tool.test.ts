import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { ChangeLog } from "../../packages/mcp-server/src/change-log.js";
import { runUndoChange } from "../../packages/mcp-server/src/change-tools.js";
import { ImageJobs, type ImageRequest, type ImageRunner } from "../../packages/mcp-server/src/image-gen.js";
import { runBuildFloorplanScene } from "../../packages/mcp-server/src/floorplan-tools.js";
import { ensureSceneBackground } from "../../packages/mcp-server/src/scene-background.js";
import { runCheckImageJob, type ImageJobMeta } from "../../packages/mcp-server/src/image-tools.js";
import type { FloorplanDeps } from "../../packages/mcp-server/src/floorplan-finish.js";

const house = {
  name: "Cottage", cols: 16, rows: 10, pxPerCell: 50,
  rooms: [
    { id: "hall", x: 1, y: 1, w: 8, h: 8, furnishings: ["long table", "fireplace"] },
    { id: "kitchen", x: 9, y: 1, w: 6, h: 4, furnishings: ["stove", "barrels"] },
    { id: "bedroom", x: 9, y: 5, w: 6, h: 4, furnishings: ["bed", "chest"] },
  ],
  openings: [
    { room: "hall", side: "w", at: 3, kind: "door", locked: true },
    { room: "hall", side: "e", at: 1, kind: "door", animation: "slide" },
    { room: "hall", side: "e", at: 5, kind: "door" },
    { room: "kitchen", side: "n", at: 2, width: 2, kind: "window" },
    { room: "bedroom", side: "s", at: 2, kind: "window" },
  ],
  lights: [{ at: [2, 4], source: "fireplace" }, { at: [10, 2], source: "torch" }],
} as const;

const dir = () => mkdtempSync(join(tmpdir(), "floorplan-"));

async function setup(opts: { foundryVersion?: string; pictureSize?: [number, number]; magick?: boolean } = {}) {
  const mock = new MockFoundry({ worldInfo: { foundryVersion: opts.foundryVersion ?? "14.368" } });
  const transport = new MockTransport(mock);
  const requests: ImageRequest[] = [];
  const runner: ImageRunner = async (request) => {
    requests.push(request);
    await mkdir(dirname(request.outPath), { recursive: true });
    await writeFile(request.outPath, Buffer.from("fake picture"));
    return { path: request.outPath };
  };
  const jobs = new ImageJobs<ImageJobMeta>(runner);
  const fits: Array<[number, number]> = [];
  const deps: FloorplanDeps = {
    hasMagick: async () => opts.magick ?? true,
    imageSize: async () => ({ width: opts.pictureSize?.[0] ?? 800, height: opts.pictureSize?.[1] ?? 500 }),
    fitImage: async (_f, w, h) => void fits.push([w, h]),
    compositePreview: async () => {},
  };
  const outputDir = dir();
  const log = new ChangeLog(join(dir(), "changes.jsonl"));
  const callOpts = (tool: string) => ({ changes: { log, requestId: `req-${tool}`, tool, warnings: [] as string[] } });
  const run = async (plan: unknown) => {
    const first = await runBuildFloorplanScene(jobs, outputDir, transport, { ...(plan as object), waitSeconds: 5 } as never, callOpts("build_floorplan_scene"), deps);
    if (first.ok && (first.data as any).status === "running") {
      return runCheckImageJob(jobs, transport, { jobId: (first.data as any).jobId, waitSeconds: 5 }, callOpts("build_floorplan_scene"));
    }
    return first;
  };
  return { mock, transport, requests, fits, run, log, callOpts, outputDir };
}

const onlyScene = (mock: MockFoundry) => [...mock.store.entries()].find(([k]) => k.startsWith("!scenes!"))![1] as any;

describe("build_floorplan_scene", () => {
  it("builds the scene, walls, doors, windows and lights in one call", async () => {
    const t = await setup();
    const out = await t.run(house);
    expect(out.ok).toBe(true);
    const scene = onlyScene(t.mock);
    expect(scene).toMatchObject({ width: 800, height: 500, grid: { size: 50, distance: 5 } });
    const doors = scene.walls.filter((w: any) => w.door === 1);
    expect(doors).toHaveLength(3);
    expect(doors.map((d: any) => d.animation.type).sort()).toEqual(["slide", "swing", "swing"]);
    expect(doors.some((d: any) => d.ds === 2)).toBe(true);
    expect(scene.walls.filter((w: any) => w.sight === 0 && w.light === 0)).toHaveLength(2);
    expect(scene.lights.map((l: any) => l.config.animation.type).sort()).toEqual(["flame", "torch"]);
    expect(t.requests[0]!.guidePath).toMatch(/guide-.*cottage.*\.png$/);
    expect(t.requests[0]!.outPath).toMatch(/floorplan-.*cottage.*\.webp$/);
    expect(t.requests[0]!.prompt).toContain("long table");
  });

  it("uploads the picture as a .webp file", async () => {
    const t = await setup();
    await t.run(house);
    expect(t.mock.filePicker.uploads[0]!.name).toMatch(/\.webp$/);
  });

  it("rejects a bad layout before starting Codex", async () => {
    const t = await setup();
    const out = await t.run({ ...house, openings: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("VALIDATION");
      expect(out.error.message).toContain("no exterior door");
    }
    expect(t.requests).toHaveLength(0);
  });

  it("refuses animated doors on Foundry 13", async () => {
    const t = await setup({ foundryVersion: "13.351" });
    const out = await t.run(house);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("UNSUPPORTED");
    expect(t.requests).toHaveLength(0);
  });

  it("resizes a picture of the wrong size and says so", async () => {
    const t = await setup({ pictureSize: [1536, 1024] });
    const out = await t.run(house);
    expect(out.ok).toBe(true);
    expect(t.fits).toEqual([[800, 500]]);
    if (out.ok) expect((out.data as any).warnings.join(" ")).toContain("resized");
  });

  it("does not resize a picture that already has the right size", async () => {
    const t = await setup();
    await t.run(house);
    expect(t.fits).toEqual([]);
  });

  it("still builds the scene and returns the overlay file when ImageMagick is missing", async () => {
    const t = await setup({ magick: false });
    const out = await t.run(house);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data as any).overlay).toMatch(/overlay-.*cottage.*\.png$/);
      expect((out.data as any).warnings.join(" ")).toContain("ImageMagick");
    }
    expect(onlyScene(t.mock).walls.length).toBeGreaterThan(0);
  });

  it("codex:false uses the blueprint itself and starts no Codex job", async () => {
    const t = await setup();
    const out = await t.run({ ...house, codex: false });
    expect(out.ok).toBe(true);
    expect(t.requests).toHaveLength(0);
    expect(onlyScene(t.mock).walls.length).toBeGreaterThan(0);
  });

  it("is undone by requestId: scene, walls and lights go together", async () => {
    const t = await setup();
    await t.run(house);
    expect([...t.mock.store.keys()].some((k) => k.startsWith("!scenes!"))).toBe(true);
    const undone = await runUndoChange(t.log, t.transport, { requestId: "req-build_floorplan_scene" }, t.callOpts("undo_change"));
    expect(undone.ok).toBe(true);
    expect([...t.mock.store.keys()].some((k) => k.startsWith("!scenes!"))).toBe(false);
  });
});

describe("ensureSceneBackground (Foundry 14 keeps the picture on the level)", () => {
  it("sets the level background, and leaves a scene without levels alone", async () => {
    const mock = new MockFoundry();
    const transport = new MockTransport(mock);
    mock.store.set("!scenes!v14", { _id: "v14", name: "A", levels: [{ _id: "l1", name: "Ground", background: {} }] });
    mock.store.set("!scenes!v13", { _id: "v13", name: "B", background: { src: "x.webp" } });
    expect((await ensureSceneBackground(transport, "v14", "pic.webp", {}))?.ok).toBe(true);
    expect((mock.store.get("!scenes!v14") as any).levels[0].background.src).toBe("pic.webp");
    expect(await ensureSceneBackground(transport, "v13", "pic.webp", {})).toBeNull();
    expect(await ensureSceneBackground(transport, "v14", "pic.webp", {})).toBeNull();
  });
});
