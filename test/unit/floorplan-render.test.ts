import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FloorplanSchema, buildGeometry } from "../../packages/shared/src/index.js";
import { Raster, renderGuide, renderOverlay, fitImage, hasMagick } from "../../packages/mcp-server/src/floorplan-render.js";
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
});
