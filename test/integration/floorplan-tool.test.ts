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
import { FloorplanSchema, buildGeometry } from "../../packages/shared/src/index.js";
import { finishFloorplan, type FloorplanApply } from "../../packages/mcp-server/src/floorplan-finish.js";
import { runBuildFloorplanScene } from "../../packages/mcp-server/src/floorplan-tools.js";
import { runCreateScene } from "../../packages/mcp-server/src/tools.js";
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
  const masked: Array<{ picture: string; mask: string; out: string }> = [];
  const deps: FloorplanDeps = {
    hasMagick: async () => opts.magick ?? true,
    imageSize: async () => ({ width: opts.pictureSize?.[0] ?? 800, height: opts.pictureSize?.[1] ?? 500 }),
    fitImage: async (_f, w, h) => void fits.push([w, h]),
    compositePreview: async () => {},
    maskToFootprint: async (picture, mask, out) => {
      masked.push({ picture, mask, out });
      await writeFile(out, "masked");
    },
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
  /** Build the apply for a plan by hand and run only the Foundry side (no Codex). */
  const runFinish = async (input: unknown) => {
    const plan = FloorplanSchema.parse(input);
    const geo = buildGeometry(plan);
    if (!geo.ok) throw new Error(geo.errors.join());
    await mkdir(outputDir, { recursive: true });
    const floors = geo.floors.map((_, i) => join(outputDir, `floor-${i}.webp`));
    for (const f of floors) await writeFile(f, "x");
    const roof = join(outputDir, "roof-pic.webp");
    await writeFile(roof, "x");
    const guide = join(outputDir, "roof-guide.png");
    await writeFile(guide, "x");
    const apply: FloorplanApply = {
      to: "floorplanScene", plan, floors: geo.floors, stairs: geo.stairs, footprint: geo.footprint,
      overlayPaths: floors.map((_, i) => join(outputDir, `overlay-${i}.png`)),
      pictures: { floors, roof: plan.roof ? roof : undefined }, roofGuidePath: guide,
    };
    return finishFloorplan({ apply, source: "data", target: "generated-images", deps }, transport, callOpts("build_floorplan_scene"));
  };
  return { mock, transport, requests, fits, masked, run, runFinish, log, callOpts, outputDir };
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
    expect(doors.every((d: any) => /^canvas\/doors\/(small|large)\/.+\.webp$/.test(d.animation.texture))).toBe(true);
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
      expect((out.data as any).overlays[0]).toMatch(/overlay-.*cottage.*\.png$/);
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

describe("Foundry 14 scene creation", () => {
  it("a scene is created with the default level", async () => {
    const mock = new MockFoundry({ worldInfo: { foundryVersion: "14.368" } });
    const transport = new MockTransport(mock);
    const out = await runCreateScene(transport, { name: "S", width: 100, height: 100 } as never, {});
    expect(out.ok).toBe(true);
    const id = (out as any).data._id;
    expect((mock.store.get(`!scenes!${id}`) as any).levels[0]._id).toBe("defaultLevel0000");
  });

  it("a Foundry 13 scene has no levels", async () => {
    const mock = new MockFoundry({ worldInfo: { foundryVersion: "13.351" } });
    const out = await runCreateScene(new MockTransport(mock), { name: "S", width: 100, height: 100 } as never, {});
    expect((mock.store.get(`!scenes!${(out as any).data._id}`) as any).levels).toBeUndefined();
  });
});

const twoFloors = {
  name: "Tower", cols: 16, rows: 10, pxPerCell: 50,
  floors: [
    { name: "Ground", rooms: [{ id: "hall", x: 1, y: 1, w: 8, h: 8 }, { id: "kitchen", x: 9, y: 1, w: 6, h: 8 }],
      openings: [{ room: "hall", side: "w", at: 3, kind: "door" }, { room: "kitchen", side: "n", at: 2, kind: "window" }],
      lights: [{ at: [2, 4], source: "fireplace" }] },
    { name: "Upstairs", rooms: [{ id: "bed", x: 1, y: 1, w: 8, h: 8 }],
      openings: [{ room: "bed", side: "n", at: 2, kind: "window" }], lights: [{ at: [2, 2], source: "candle" }] },
  ],
  stairs: [{ at: [4, 3], dir: "e" }],
};

describe("finishFloorplan: floors, stairs and roof", () => {
  it("creates levels, per-level walls and lights, a stair region and a roof tile", async () => {
    const t = await setup();
    const out = await t.runFinish(twoFloors);
    expect(out.ok).toBe(true);
    const scene = onlyScene(t.mock);
    const [l0, l1] = scene.levels;
    expect(l0).toMatchObject({ _id: "defaultLevel0000", name: "Ground", elevation: { bottom: 0, top: 10 } });
    expect(l1).toMatchObject({ name: "Upstairs", elevation: { bottom: 10, top: 20 } });
    expect(l0.background.src).toMatch(/\.webp$/);
    expect(l1.background.src).toMatch(/\.webp$/);
    expect(l0.background.src).not.toBe(l1.background.src);
    expect(scene.walls.filter((w: any) => w.levels[0] === l0._id).length).toBeGreaterThan(0);
    expect(scene.walls.filter((w: any) => w.levels[0] === l1._id).length).toBeGreaterThan(0);
    expect(scene.walls.every((w: any) => w.levels.length === 1)).toBe(true);
    expect(scene.lights.map((l: any) => l.levels[0]).sort()).toEqual([l0._id, l1._id].sort());
    const stair = scene.regions[0];
    expect(stair).toMatchObject({ levels: [l0._id, l1._id], elevation: { bottom: 0, top: 20 } });
    expect(stair.behaviors[0]).toMatchObject({ type: "changeLevel", system: { movementActions: ["walk"] } });
    expect(stair.shapes[0]).toMatchObject({ type: "rectangle", width: 150, height: 50 });
    const roof = scene.tiles[0];
    expect(roof).toMatchObject({ width: 800, height: 500, elevation: 20, levels: [l0._id, l1._id], occlusion: { modes: [1, 8], alpha: 0 } });
    expect(roof.texture.src).toMatch(/roof.*\.webp$/);
    expect(scene.tokenVision).toBe(true);
    const data = (out as any).data;
    expect(data.levels).toEqual([{ id: l0._id, name: "Ground" }, { id: l1._id, name: "Upstairs" }]);
    expect(data.roof.tileId).toBe(roof._id);
    expect(data.stairs).toBe(1);
  });

  it("applies the scene's grid origin to the stair region and the roof tile", async () => {
    const t = await setup();
    await t.runFinish(twoFloors);
    const scene = onlyScene(t.mock);
    const ox = Math.ceil((800 * 0.25) / 50) * 50;
    const oy = Math.ceil((500 * 0.25) / 50) * 50;
    expect(ox + oy).toBeGreaterThan(0);
    expect(scene.regions[0].shapes[0]).toMatchObject({ x: 4 * 50 + ox, y: 3 * 50 + oy });
    expect(scene.tiles[0]).toMatchObject({ x: ox, y: oy });
  });

  it("masks the roof picture to the footprint before uploading it", async () => {
    const t = await setup();
    await t.runFinish(twoFloors);
    expect(t.masked).toHaveLength(1);
    expect(t.masked[0]!.mask).toMatch(/roof-guide/);
    expect(t.mock.filePicker.uploads.some((u: any) => /roof/.test(u.name))).toBe(true);
  });

  it("skips the roof with a warning when ImageMagick is missing, and still builds the floors", async () => {
    const t = await setup({ magick: false });
    const out = await t.runFinish(twoFloors);
    expect(out.ok).toBe(true);
    const scene = onlyScene(t.mock);
    expect(scene.tiles ?? []).toHaveLength(0);
    expect(scene.levels).toHaveLength(2);
    expect((out as any).data.roof).toBeNull();
    expect((out as any).data.warnings.join(" ")).toMatch(/roof/i);
  });

  it("roof:false builds no roof tile and no roof upload", async () => {
    const t = await setup();
    await t.runFinish({ ...twoFloors, roof: false });
    expect(onlyScene(t.mock).tiles ?? []).toHaveLength(0);
    expect(t.mock.filePicker.uploads.some((u: any) => /roof/.test(u.name))).toBe(false);
  });

  it("a single floor still builds one level, its walls on that level, and a roof", async () => {
    const t = await setup();
    await t.runFinish({ name: "One", cols: 8, rows: 6, pxPerCell: 50, rooms: [{ id: "a", x: 1, y: 1, w: 6, h: 4 }], openings: [{ room: "a", side: "s", at: 1, kind: "door" }] });
    const scene = onlyScene(t.mock);
    expect(scene.levels).toHaveLength(1);
    expect(scene.walls.every((w: any) => w.levels[0] === "defaultLevel0000")).toBe(true);
    expect(scene.tiles).toHaveLength(1);
    expect(scene.regions ?? []).toHaveLength(0);
  });

  it("is undone by requestId including levels, regions and the roof tile", async () => {
    const t = await setup();
    await t.runFinish(twoFloors);
    const undone = await runUndoChange(t.log, t.transport, { requestId: "req-build_floorplan_scene" }, t.callOpts("undo_change"));
    expect(undone.ok).toBe(true);
    expect([...t.mock.store.keys()].some((k) => k.startsWith("!scenes!"))).toBe(false);
  });
});
