import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { ChangeLog } from "../../packages/mcp-server/src/change-log.js";
import { runUndoChange } from "../../packages/mcp-server/src/change-tools.js";
import { ImageJobs, ImageRunError, type ImageRequest, type ImageRunner } from "../../packages/mcp-server/src/image-gen.js";
import { FloorplanSchema, buildGeometry, resolveRoofs } from "../../packages/shared/src/index.js";
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

async function setup(opts: { failOn?: number; foundryVersion?: string; pictureSize?: [number, number]; magick?: boolean } = {}) {
  const mock = new MockFoundry({ worldInfo: { foundryVersion: opts.foundryVersion ?? "14.368" } });
  const transport = new MockTransport(mock);
  const requests: ImageRequest[] = [];
  const runner: ImageRunner = async (request) => {
    requests.push(request);
    if (opts.failOn && requests.length === opts.failOn) throw new ImageRunError("INTERNAL", "boom");
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
    const roofs = resolveRoofs(plan);
    const roofEntries = [];
    for (let i = 0; i < roofs.length; i++) {
      const picture = join(outputDir, roofs.length === 1 ? "roof-pic.webp" : `roof-pic-${i}.webp`);
      const maskPath = join(outputDir, roofs.length === 1 ? "roof-guide.png" : `roof-guide-${i}.png`);
      await writeFile(picture, "x");
      await writeFile(maskPath, "x");
      roofEntries.push({ name: roofs[i]!.name, explicit: roofs[i]!.explicit, top: roofs[i]!.top, picture, maskPath });
    }
    const apply: FloorplanApply = {
      to: "floorplanScene", plan, floors: geo.floors, stairs: geo.stairs, footprint: geo.footprint,
      overlayPaths: floors.map((_, i) => join(outputDir, `overlay-${i}.png`)),
      pictures: { floors }, roofs: roofEntries,
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
    const out = await t.run({ ...house, roof: false });
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
    // Foundry 14 tiles are anchored at their centre by default; x/y is the top-left corner only with anchor 0.
    expect(scene.tiles[0].texture).toMatchObject({ anchorX: 0, anchorY: 0 });
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

describe("build_floorplan_scene: floors, stairs and roof through the tool", () => {
  it("a two-floor house with a roof is one job with three images: floor, floor, roof", async () => {
    const t = await setup();
    const out = await t.run(twoFloors);
    expect(out.ok).toBe(true);
    expect(t.requests).toHaveLength(3);
    expect(t.requests[0]!.prompt).toContain("hall");
    expect(t.requests[1]!.prompt).toContain("bed");
    expect(t.requests[2]!.prompt).toMatch(/roof/i);
    expect(t.requests.every((r) => r.guidePath)).toBe(true);
    const scene = onlyScene(t.mock);
    expect(scene.levels).toHaveLength(2);
    expect(scene.tiles).toHaveLength(1);
    expect(scene.regions).toHaveLength(1);
  });

  it("roof:false is two images; a one-floor house without a roof is one image", async () => {
    const t = await setup();
    await t.run({ ...twoFloors, roof: false });
    expect(t.requests).toHaveLength(2);
    const u = await setup();
    await u.run({ ...house, roof: false });
    expect(u.requests).toHaveLength(1);
  });

  it("a one-floor house gets a roof by default: two images", async () => {
    const t = await setup();
    await t.run(house);
    expect(t.requests).toHaveLength(2);
    expect(onlyScene(t.mock).tiles).toHaveLength(1);
  });

  it("codex:false uses the blueprints as pictures: no Codex run, levels still built", async () => {
    const t = await setup();
    const out = await t.run({ ...twoFloors, codex: false });
    expect(out.ok).toBe(true);
    expect(t.requests).toHaveLength(0);
    expect(onlyScene(t.mock).levels).toHaveLength(2);
  });

  it("rejects an invalid stair layout before any Codex run", async () => {
    const t = await setup();
    const out = await t.run({ ...twoFloors, stairs: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("VALIDATION");
      expect(out.error.message).toContain("unreachable");
    }
    expect(t.requests).toHaveLength(0);
  });

  it("rejects floors together with top-level rooms as a validation error", async () => {
    const t = await setup();
    const out = await t.run({ ...twoFloors, rooms: house.rooms });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("VALIDATION");
  });

  it("a failing image fails the whole job and builds no scene", async () => {
    const t = await setup({ failOn: 2 });
    const out = await t.run(twoFloors);
    expect(out.ok).toBe(false);
    expect([...t.mock.store.keys()].some((k) => k.startsWith("!scenes!"))).toBe(false);
  });
});

describe("build_floorplan_scene: a roof per wing", () => {
  // A hall of two floors under a slate roof, a one-storey kitchen annex under thatch, and a conical tower.
  const wings = {
    name: "Manor", cols: 24, rows: 12, pxPerCell: 50,
    floors: [
      { name: "Ground", rooms: [{ id: "hall", x: 1, y: 1, w: 10, h: 8 }, { id: "kitchen", x: 11, y: 4, w: 5, h: 5 }, { id: "tower", x: 16, y: 1, w: 4, h: 4 }],
        openings: [{ room: "hall", side: "s", at: 3, kind: "door" }], lights: [{ at: [3, 3], source: "fireplace" }, { at: [13, 6], source: "fireplace" }] },
      { name: "Upstairs", rooms: [{ id: "loft", x: 1, y: 1, w: 10, h: 8 }, { id: "tower", x: 16, y: 1, w: 4, h: 4 }] },
    ],
    stairs: [{ at: [3, 5], dir: "e", length: 3 }, { at: [17, 2], dir: "e", length: 2, width: 2, style: "spiral" }],
    roofStyle: "thatched roof",
    roofs: [
      { name: "main house", rooms: ["hall", "loft"], style: "slate roof", shape: "gabled", condition: "mossy" },
      { name: "tower", rooms: ["tower"], style: "copper roof", shape: "conical", chimneys: false },
    ],
  };

  it("builds one tile per roof, each on top of its own floor and seen from the levels up to it", async () => {
    const t = await setup();
    const out = await t.runFinish(wings);
    expect(out.ok).toBe(true);
    const scene = onlyScene(t.mock);
    const [l0, l1] = scene.levels;
    expect(scene.tiles).toHaveLength(3);
    const byName = (n: string) => scene.tiles.find((x: any) => x.name.endsWith(n));
    expect(byName("roof: main")).toMatchObject({ elevation: 10, levels: [l0._id] });
    expect(byName("roof: main house")).toMatchObject({ elevation: 20, levels: [l0._id, l1._id] });
    expect(byName("roof: tower")).toMatchObject({ elevation: 20, levels: [l0._id, l1._id] });
    expect((out as any).data.roofs.map((r: any) => r.name)).toEqual(["main", "main house", "tower"]);
    expect((out as any).data.roof.tileId).toBe(byName("roof: main")._id);
  });

  it("masks every roof with its own mask", async () => {
    const t = await setup();
    await t.runFinish(wings);
    expect(t.masked).toHaveLength(3);
    expect(new Set(t.masked.map((m) => m.mask)).size).toBe(3);
  });

  it("the tool paints one picture per roof with its own prompt: floors, then main, house, tower", async () => {
    const t = await setup();
    const out = await t.run(wings);
    expect(out.ok).toBe(true);
    expect(t.requests).toHaveLength(5);
    const [, , main, house2, tower] = t.requests;
    expect(main!.prompt).toContain("thatched roof");
    expect(main!.prompt).not.toContain("copper");
    expect(house2!.prompt).toMatch(/slate roof \(mossy\).*roof over the main house.*gabled/s);
    expect(tower!.prompt).toMatch(/copper roof.*conical/s);
    expect(tower!.prompt).toContain("no chimneys");
    expect(house2!.prompt).toMatch(/chimney stack/);
    expect(onlyScene(t.mock).tiles).toHaveLength(3);
  });

  it("without roofs the house still has one roof and the tile is named plainly", async () => {
    const t = await setup();
    await t.runFinish({ ...wings, roofs: [] });
    const scene = onlyScene(t.mock);
    expect(scene.tiles).toHaveLength(1);
    expect(scene.tiles[0].name).toBe("Manor roof");
  });

  it("skips every roof with a warning without ImageMagick", async () => {
    const t = await setup({ magick: false });
    const out = await t.runFinish(wings);
    expect(out.ok).toBe(true);
    expect((out as any).data.roofs).toEqual([]);
    expect((out as any).data.roof).toBeNull();
    expect((out as any).data.warnings.join(" ")).toMatch(/roof was skipped/);
  });
});

describe("build_floorplan_scene: cellars", () => {
  const inn = {
    name: "Inn", cols: 24, rows: 14, pxPerCell: 50,
    floors: [
      { name: "Ground", rooms: [{ id: "bar", x: 4, y: 3, w: 10, h: 7 }], openings: [{ room: "bar", side: "s", at: 2, kind: "door" }] },
      { name: "Upstairs", rooms: [{ id: "bed", x: 4, y: 3, w: 10, h: 7 }] },
    ],
    cellars: [{ name: "Cellar", rooms: [{ id: "store", x: 1, y: 1, w: 12, h: 8 }, { id: "tunnel", x: 13, y: 4, w: 10, h: 2 }] }, { name: "Crypt", rooms: [{ id: "crypt", x: 2, y: 2, w: 6, h: 5 }] }],
    stairs: [{ at: [6, 4], dir: "e", length: 3 }, { at: [5, 3], dir: "e", length: 3, from: -1 }, { at: [3, 3], dir: "s", length: 3, from: -2 }],
  };
  it("creates the cellar levels below zero, the ground floor at zero, and puts stairs and roof at the right heights", async () => {
    const t = await setup();
    const out = await t.runFinish(inn);
    expect(out.ok).toBe(true);
    const scene = onlyScene(t.mock);
    const [crypt, cellar, ground, upstairs] = scene.levels;
    expect(crypt).toMatchObject({ _id: "defaultLevel0000", name: "Crypt", elevation: { bottom: -20, top: -10 } });
    expect(cellar).toMatchObject({ name: "Cellar", elevation: { bottom: -10, top: 0 } });
    expect(ground).toMatchObject({ name: "Ground", elevation: { bottom: 0, top: 10 } });
    expect(upstairs).toMatchObject({ name: "Upstairs", elevation: { bottom: 10, top: 20 } });
    expect((out as any).data.groundFloor).toBe(2);
    const regions = scene.regions;
    expect(regions).toHaveLength(3);
    const between = (a: any, b: any) => regions.find((r: any) => r.levels[0] === a._id && r.levels[1] === b._id);
    expect(between(ground, upstairs).elevation).toEqual({ bottom: 0, top: 20 });
    expect(between(cellar, ground).elevation).toEqual({ bottom: -10, top: 10 });
    expect(between(crypt, cellar).elevation).toEqual({ bottom: -20, top: 0 });
    // one roof over the building only: from the ground floor up, never the cellars
    expect(scene.tiles).toHaveLength(1);
    expect(scene.tiles[0]).toMatchObject({ elevation: 20, levels: [ground._id, upstairs._id] });
    // every floor has its own walls
    for (const lv of [crypt, cellar, ground, upstairs]) expect(scene.walls.some((w: any) => w.levels[0] === lv._id)).toBe(true);
  });
  it("the tool paints one picture per floor, cellars included, and one roof: five images", async () => {
    const t = await setup();
    const out = await t.run(inn);
    expect(out.ok).toBe(true);
    expect(t.requests).toHaveLength(5);
    const prompts = t.requests.map((r) => r.prompt);
    expect(prompts[0]).toContain("underground Crypt");
    expect(prompts[1]).toContain("underground Cellar");
    expect(prompts[2]).toContain("green area outside is grass");
    expect(prompts[4]).toMatch(/roof/i);
    expect(prompts.filter((p) => /solid earth and rock/.test(p))).toHaveLength(2);
  });
  it("a house without cellars is unchanged: ground floor at zero", async () => {
    const t = await setup();
    await t.runFinish(twoFloors);
    const [l0] = onlyScene(t.mock).levels;
    expect(l0.elevation).toEqual({ bottom: 0, top: 10 });
  });
});
