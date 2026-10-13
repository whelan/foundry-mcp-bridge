import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FloorplanSchema, buildGeometry } from "../../packages/shared/src/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Raster, renderGuide, renderOverlay, renderRoofGuide, maskToFootprint, fitImage, hasMagick, imageSize } from "../../packages/mcp-server/src/floorplan-render.js";
import { pngSize } from "../../packages/mcp-server/src/image-gen.js";

const plan = FloorplanSchema.parse({
  name: "T", cols: 8, rows: 6, pxPerCell: 50,
  rooms: [{ id: "a", x: 1, y: 1, w: 6, h: 4 }],
  openings: [{ room: "a", side: "s", at: 2, kind: "door" }, { room: "a", side: "n", at: 1, width: 2, kind: "window" }],
  lights: [{ at: [2, 2], source: "torch" }],
});
const geometry = (() => { const g = buildGeometry(plan); if (!g.ok) throw new Error(g.errors.join()); return g; })();

/** Decode our own RGBA PNG back to pixels (the tests only ever read PNGs this module wrote). */
function decode(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let idat = Buffer.alloc(0);
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    if (png.toString("ascii", o + 4, o + 8) === "IDAT") idat = Buffer.concat([idat, png.subarray(o + 8, o + 8 + len)]);
    o += 12 + len;
  }
  const raw = inflateSync(idat);
  const px = (x: number, y: number) => { const i = y * (1 + width * 4) + 1 + x * 4; return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]; };
  return { width, height, px };
}

describe("Raster", () => {
  it("writes a valid PNG of the right size", () => {
    const r = new Raster(10, 4);
    r.fillRect(0, 0, 10, 4, [1, 2, 3, 255]);
    expect(pngSize(r.toPng())).toEqual({ width: 10, height: 4 });
  });
  it("clips drawing at the edges", () => {
    const r = new Raster(4, 4);
    expect(() => r.fillRect(-5, -5, 20, 20, [9, 9, 9, 255])).not.toThrow();
    expect(r.pixel(3, 3)).toEqual([9, 9, 9, 255]);
  });
});

describe("renderGuide", () => {
  const img = decode(renderGuide(plan, geometry.walls));
  it("is exactly cols x rows cells", () => {
    expect([img.width, img.height]).toEqual([400, 300]);
  });
  it("paints the outside, the floor and the wall differently", () => {
    const outside = img.px(10, 10);
    const floor = img.px(200, 150);
    const wall = img.px(60, 50); // on the north wall line y=1 cell => 50px
    expect(new Set([outside.join(), floor.join(), wall.join()]).size).toBe(3);
  });
  it("draws the doorway differently from the wall around it", () => {
    const door = img.px(175, 250); // south wall y=(1+4)*50=250, door x=(1+2)*50=150..200
    const wall = img.px(60, 250);
    expect(door.join()).not.toBe(wall.join());
  });
});

describe("renderOverlay", () => {
  const img = decode(renderOverlay(plan, geometry.walls, geometry.lights));
  it("is transparent where nothing is drawn", () => {
    expect(img.px(5, 5)[3]).toBe(0);
  });
  it("marks a wall, a window and a light", () => {
    expect(img.px(60, 250)[3]).toBeGreaterThan(0); // plain south wall
    expect(img.px(100, 50)[3]).toBeGreaterThan(0); // window on the north wall
    expect(img.px(125, 125)[3]).toBeGreaterThan(0); // torch at cell [2,2] => centre (2.5*50, 2.5*50)
  });
});


describe("fitImage", async () => {
  const magick = await hasMagick();
  it.skipIf(!magick)("resizes to exactly the requested size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-"));
    const file = join(dir, "a.png");
    writeFileSync(file, renderGuide(plan, geometry.walls));
    await fitImage(file, 160, 120);
    expect(pngSize(readFileSync(file))).toEqual({ width: 160, height: 120 });
  });
  it.skipIf(!magick)("reads the size of a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "size-"));
    const file = join(dir, "a.png");
    writeFileSync(file, renderGuide(plan, geometry.walls));
    expect(await imageSize(file)).toEqual({ width: 400, height: 300 });
  });
});

const STAIR_COLOUR = [230, 190, 60, 255];
const stairPlan = (floors: number) =>
  FloorplanSchema.parse({
    name: "S", cols: 8, rows: 6, pxPerCell: 50,
    floors: [
      { name: "G", rooms: [{ id: "a", x: 0, y: 0, w: 8, h: 6 }], openings: [{ room: "a", side: "s", at: 1, kind: "door" }] },
      ...Array.from({ length: floors - 1 }, (_, i) => ({ name: `U${i}`, rooms: [{ id: `b${i}`, x: 0, y: 0, w: 8, h: 6 }] })),
    ],
    stairs: [{ at: [2, 2], dir: "e" }, ...(floors > 2 ? [{ at: [2, 2], dir: "e", from: 1 }] : [])],
  });
const geometryOf = (p: ReturnType<typeof stairPlan>) => { const g = buildGeometry(p); if (!g.ok) throw new Error(g.errors.join()); return g; };

describe("stairs and roof drawing", () => {
  it("draws a stair in the guide on both floors it joins, in its own colour", () => {
    const p = stairPlan(2);
    const g = geometryOf(p);
    for (const floor of [0, 1]) {
      const img = decode(renderGuide(p, g.floors[floor]!.walls, { floor, stairs: g.stairs }));
      expect(img.px(2 * 50 + 25, 2 * 50 + 25)).toEqual(STAIR_COLOUR);
    }
  });

  it("does not draw a stair on a floor it does not touch", () => {
    const p = stairPlan(3);
    const g = geometryOf(p);
    const onlyFirst = g.stairs.filter((s) => s.from === 0);
    const top = decode(renderGuide(p, g.floors[2]!.walls, { floor: 2, stairs: onlyFirst }));
    expect(top.px(125, 125)).not.toEqual(STAIR_COLOUR);
  });

  it("the roof guide is white over every room plus the eave, black elsewhere", () => {
    const p = FloorplanSchema.parse({ name: "S", cols: 10, rows: 8, pxPerCell: 50, rooms: [{ id: "a", x: 2, y: 2, w: 4, h: 3 }] });
    const img = decode(renderRoofGuide(p, [{ x: 2, y: 2, w: 4, h: 3 }], 0.4));
    expect(img.px(3 * 50, 3 * 50)).toEqual([255, 255, 255, 255]);
    expect(img.px(2 * 50 - 10, 3 * 50)).toEqual([255, 255, 255, 255]);
    expect(img.px(2 * 50 - 30, 3 * 50)).toEqual([0, 0, 0, 255]);
    expect(img.px(0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("renderOverlay outlines stairs", () => {
    const p = stairPlan(2);
    const img = decode(renderOverlay(p, [], [], [{ from: 0, to: 1, x: 2, y: 2, w: 3, h: 1, dir: "e" }]));
    expect(img.px(2 * 50 + 2, 2 * 50 + 25)![3]).toBeGreaterThan(0);
    expect(img.px(2 * 50 + 25, 2 * 50 + 25)![3]).toBe(0);
  });
});

describe("maskToFootprint", async () => {
  const magick = await hasMagick();
  it.skipIf(!magick)("clears the outside and keeps the inside", async () => {
    const run = promisify(execFile);
    const dir = mkdtempSync(join(tmpdir(), "mask-"));
    const p = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, pxPerCell: 50, rooms: [{ id: "a", x: 2, y: 2, w: 3, h: 2 }] });
    const mask = join(dir, "mask.png");
    writeFileSync(mask, renderRoofGuide(p, [{ x: 2, y: 2, w: 3, h: 2 }], 0));
    const pic = join(dir, "pic.png");
    await run("magick", ["-size", "400x300", "xc:red", pic]);
    const out = join(dir, "out.webp");
    await maskToFootprint(pic, mask, out);
    const { stdout } = await run("magick", [out, "-format", "%[fx:p{125,125}.a] %[fx:p{10,10}.a]", "info:"]);
    const [inside, outside] = stdout.trim().split(" ").map(Number);
    expect(inside).toBeGreaterThan(0.9);
    expect(outside).toBeLessThan(0.1);
  });
});
