/**
 * Pure PNG drawing for the floorplan tool: the blueprint guide Codex paints over, and the
 * overlay that shows where Foundry's walls and lights will sit. No image dependency.
 */

import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Floorplan, PlacedLight, WallSegment } from "@foundry-mcp-bridge/shared";

const run = promisify(execFile);

type Rgba = [number, number, number, number];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

export class Raster {
  private readonly data: Uint8Array;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(width * height * 4);
  }
  pixel(x: number, y: number): Rgba {
    const i = (y * this.width + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }
  fillRect(x: number, y: number, w: number, h: number, c: Rgba): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.data.set(c, (py * this.width + px) * 4);
  }
  fillCircle(cx: number, cy: number, r: number, c: Rgba): void {
    for (let py = Math.max(0, Math.floor(cy - r)); py <= Math.min(this.height - 1, Math.ceil(cy + r)); py++)
      for (let px = Math.max(0, Math.floor(cx - r)); px <= Math.min(this.width - 1, Math.ceil(cx + r)); px++)
        if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) this.data.set(c, (py * this.width + px) * 4);
  }
  toPng(): Buffer {
    const row = 1 + this.width * 4;
    const raw = Buffer.alloc(row * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * row] = 0;
      Buffer.from(this.data.buffer, this.data.byteOffset + y * this.width * 4, this.width * 4).copy(raw, y * row + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8;
    header[9] = 6; // RGBA
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  }
}

/** A thick axis-aligned line centred on the segment, in pixels. */
function drawSegment(r: Raster, seg: WallSegment, px: number, thickness: number, c: Rgba): void {
  const x1 = seg.x1 * px;
  const y1 = seg.y1 * px;
  const x2 = seg.x2 * px;
  const y2 = seg.y2 * px;
  const half = thickness / 2;
  if (y1 === y2) r.fillRect(Math.min(x1, x2) - half, y1 - half, Math.abs(x2 - x1) + thickness, thickness, c);
  else r.fillRect(x1 - half, Math.min(y1, y2) - half, thickness, Math.abs(y2 - y1) + thickness, c);
}

const OUTSIDE: Rgba = [96, 112, 84, 255];
const WALL: Rgba = [43, 33, 24, 255];
const DOOR: Rgba = [139, 90, 43, 255];
const SECRET: Rgba = [43, 33, 24, 255];
const WINDOW: Rgba = [150, 200, 230, 255];
const FLOORS: Rgba[] = [[217, 201, 168, 255], [201, 190, 170, 255], [208, 186, 160, 255], [196, 200, 176, 255]];

/** Blueprint: exact room rectangles, walls, doors and windows at pxPerCell. Codex paints over it. */
export function renderGuide(plan: Floorplan, walls: WallSegment[]): Buffer {
  const px = plan.pxPerCell;
  const r = new Raster(plan.cols * px, plan.rows * px);
  r.fillRect(0, 0, r.width, r.height, OUTSIDE);
  plan.rooms.forEach((room, i) => r.fillRect(room.x * px, room.y * px, room.w * px, room.h * px, FLOORS[i % FLOORS.length]!));
  const t = Math.max(4, Math.round(px * 0.12));
  for (const w of walls) {
    const colour = w.kind === "door" ? DOOR : w.kind === "secretDoor" ? SECRET : w.kind === "window" ? WINDOW : WALL;
    drawSegment(r, w, px, t, colour);
  }
  return r.toPng();
}

const OV_WALL: Rgba = [255, 40, 40, 255];
const OV_DOOR: Rgba = [40, 220, 80, 255];
const OV_WINDOW: Rgba = [40, 200, 255, 255];
const OV_LIGHT: Rgba = [255, 230, 40, 255];

/** Transparent overlay: red walls, green doors, cyan windows, yellow lights. */
export function renderOverlay(plan: Floorplan, walls: WallSegment[], lights: PlacedLight[]): Buffer {
  const px = plan.pxPerCell;
  const r = new Raster(plan.cols * px, plan.rows * px);
  for (const w of walls) {
    const colour = w.kind === "door" || w.kind === "secretDoor" ? OV_DOOR : w.kind === "window" ? OV_WINDOW : OV_WALL;
    drawSegment(r, w, px, 6, colour);
  }
  for (const l of lights) r.fillCircle(l.col * px, l.row * px, Math.max(6, px * 0.12), OV_LIGHT);
  return r.toPng();
}

/** True when ImageMagick's `magick` is on PATH. */
export async function hasMagick(): Promise<boolean> {
  try {
    await run("magick", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Resize `file` in place to exactly width x height (non-uniform: walls must land on the grid). */
export async function fitImage(file: string, width: number, height: number): Promise<void> {
  await run("magick", [file, "-resize", `${width}x${height}!`, file]);
}

/** Overlay on top of the picture as a PNG for a quick visual check. */
export async function compositePreview(picture: string, overlayPng: string, out: string): Promise<void> {
  await run("magick", [picture, overlayPng, "-compose", "over", "-composite", out]);
}
