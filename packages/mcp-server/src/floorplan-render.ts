/**
 * Pure PNG drawing for the floorplan tool: the blueprint guide Codex paints over, and the
 * overlay that shows where Foundry's walls and lights will sit. No image dependency.
 */

import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SURROUNDING_STYLE, resolveConstruction, wallThicknessPx, type ResolvedRoof, type Floorplan, type PlacedLight, type PlacedStair, type WallSegment } from "@foundry-mcp-bridge/shared";

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
  /** A line of the given thickness, drawn as overlapping discs. */
  drawLine(x1: number, y1: number, x2: number, y2: number, thickness: number, c: Rgba): void {
    const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
    const r = thickness / 2;
    for (let i = 0; i <= len; i++) this.fillCircle(x1 + ((x2 - x1) * i) / len, y1 + ((y2 - y1) * i) / len, r, c);
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

const STAIR: Rgba = [230, 190, 60, 255];
const STAIR_TREAD: Rgba = [120, 90, 30, 255];
const STAIR_RAIL: Rgba = [70, 40, 20, 255];
const STAIR_CARPET: Rgba = [190, 60, 50, 255];
const OV_STAIR: Rgba = [230, 60, 230, 255];

/** A stair as a yellow block with treads, or (for the overlay) just its outline. */
function drawStairs(r: Raster, stairs: PlacedStair[], px: number, outline: boolean): void {
  for (const s of stairs) {
    if (outline) {
      const t = 4;
      r.fillRect(s.x * px, s.y * px, s.w * px, t, OV_STAIR);
      r.fillRect(s.x * px, (s.y + s.h) * px - t, s.w * px, t, OV_STAIR);
      r.fillRect(s.x * px, s.y * px, t, s.h * px, OV_STAIR);
      r.fillRect((s.x + s.w) * px - t, s.y * px, t, s.h * px, OV_STAIR);
      continue;
    }
    r.fillRect(s.x * px, s.y * px, s.w * px, s.h * px, STAIR);
    const horizontal = s.dir === "e" || s.dir === "w";
    const steps = horizontal ? s.w : s.h;
    const x0 = s.x * px;
    const y0 = s.y * px;
    const W = s.w * px;
    const H = s.h * px;
    if (s.style === "spiral") {
      // A round stair around a post: ring, spokes, post.
      const cx = x0 + W / 2;
      const cy = y0 + H / 2;
      const rad = Math.min(W, H) / 2;
      r.fillCircle(cx, cy, rad - 2, STAIR_TREAD);
      r.fillCircle(cx, cy, rad - 5, STAIR);
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        for (let d = rad * 0.2; d < rad - 4; d += 1) r.fillRect(cx + Math.cos(ang) * d - 1, cy + Math.sin(ang) * d - 1, 3, 3, STAIR_TREAD);
      }
      r.fillCircle(cx, cy, Math.max(4, rad * 0.18), STAIR_TREAD);
      continue;
    }
    // Treads: coarse for stone, fine and thin for a ladder (rungs), normal otherwise.
    const tread = s.style === "stone" ? 5 : 3;
    const count = s.style === "ladder" ? steps * 3 : steps;
    for (let i = 1; i < count; i++) {
      const at = (i * (horizontal ? W : H)) / count;
      if (horizontal) r.fillRect(x0 + at - tread / 2, y0, tread, H, STAIR_TREAD);
      else r.fillRect(x0, y0 + at - tread / 2, W, tread, STAIR_TREAD);
    }
    const rail = Math.max(4, Math.round(px * 0.08));
    if (s.style === "grand") {
      // A carpet runner down the middle and a balustrade along both long sides.
      if (horizontal) {
        r.fillRect(x0, y0 + H * 0.3, W, H * 0.4, STAIR_CARPET);
        r.fillRect(x0, y0, W, rail, STAIR_RAIL);
        r.fillRect(x0, y0 + H - rail, W, rail, STAIR_RAIL);
      } else {
        r.fillRect(x0 + W * 0.3, y0, W * 0.4, H, STAIR_CARPET);
        r.fillRect(x0, y0, rail, H, STAIR_RAIL);
        r.fillRect(x0 + W - rail, y0, rail, H, STAIR_RAIL);
      }
    } else if (s.style === "ladder") {
      // Two rails; the rungs are the fine treads above.
      if (horizontal) {
        r.fillRect(x0, y0 + H * 0.15, W, 3, STAIR_RAIL);
        r.fillRect(x0, y0 + H * 0.85 - 3, W, 3, STAIR_RAIL);
      } else {
        r.fillRect(x0 + W * 0.15, y0, 3, H, STAIR_RAIL);
        r.fillRect(x0 + W * 0.85 - 3, y0, 3, H, STAIR_RAIL);
      }
    } else if (s.style === "plain") {
      // One handrail along the long side.
      if (horizontal) r.fillRect(x0, y0, W, 3, STAIR_RAIL);
      else r.fillRect(x0, y0, 3, H, STAIR_RAIL);
    }
  }
}

/** Blueprint of one floor: exact room rectangles, walls, doors, windows and the stairs that touch it. Codex paints over it. */
export function renderGuide(plan: Floorplan, walls: WallSegment[], opts: { floor?: number; stairs?: PlacedStair[] } = {}): Buffer {
  const px = plan.pxPerCell;
  const floor = opts.floor ?? 0;
  const r = new Raster(plan.cols * px, plan.rows * px);
  r.fillRect(0, 0, r.width, r.height, OUTSIDE);
  // The ground outside is part of the ground floor's picture only.
  if (floor === 0) {
    for (const f of plan.surroundings?.features ?? []) {
      const [cr, cg, cb] = SURROUNDING_STYLE[f.kind].rgb;
      r.fillRect(f.x * px, f.y * px, f.w * px, f.h * px, [cr, cg, cb, 255]);
    }
  }
  plan.floors[floor]!.rooms.forEach((room, i) => r.fillRect(room.x * px, room.y * px, room.w * px, room.h * px, FLOORS[i % FLOORS.length]!));
  drawStairs(r, (opts.stairs ?? []).filter((s) => s.from === floor || s.to === floor), px, false);
  // Outer walls and the walls between rooms differ per house; a door or window is exactly as thick as the wall it sits in.
  const build = resolveConstruction(plan);
  const tOuter = wallThicknessPx(plan, build.exterior.thickness);
  const tInner = wallThicknessPx(plan, build.interior.thickness);
  const roomsPerEdge = new Map<string, number>();
  const edgeId = (o: "h" | "v", x: number, y: number) => `${o}:${x}:${y}`;
  for (const room of plan.floors[floor]!.rooms) {
    for (let i = 0; i < room.w; i++) for (const y of [room.y, room.y + room.h]) roomsPerEdge.set(edgeId("h", room.x + i, y), (roomsPerEdge.get(edgeId("h", room.x + i, y)) ?? 0) + 1);
    for (let j = 0; j < room.h; j++) for (const x of [room.x, room.x + room.w]) roomsPerEdge.set(edgeId("v", x, room.y + j), (roomsPerEdge.get(edgeId("v", x, room.y + j)) ?? 0) + 1);
  }
  const rooms = plan.floors[floor]!.rooms;
  /** The floor colour of the room beside a doorway: the gap is painted as floor, so the painter leaves it open. */
  const floorBeside = (cells: Array<[number, number]>): Rgba => {
    for (const [cx, cy] of cells) {
      const i = rooms.findIndex((room) => cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.h);
      if (i >= 0) return FLOORS[i % FLOORS.length]!;
    }
    return FLOORS[0]!;
  };
  for (const w of walls) {
    // Doors are added by Foundry (animated), so a doorway is an empty gap in the wall; a secret door looks like plain wall.
    const colour = w.kind === "window" ? WINDOW : w.kind === "door" ? DOOR : WALL;
    const horizontal = w.y1 === w.y2;
    const from = horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
    const to = horizontal ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
    for (let u = from; u < to; u++) {
      const exterior = roomsPerEdge.get(horizontal ? edgeId("h", u, w.y1) : edgeId("v", w.x1, u)) === 1;
      const t = exterior ? tOuter : tInner;
      const piece: WallSegment = horizontal ? { ...w, x1: u, x2: u + 1 } : { ...w, y1: u, y2: u + 1 };
      // Plain walls overshoot by half a thickness so corners close; doors and windows stay inside their gap.
      if (w.kind === "wall" || w.kind === "secretDoor") drawSegment(r, piece, px, t, colour);
      else if (w.kind === "door") {
        const gap = floorBeside(horizontal ? [[u, w.y1 - 1], [u, w.y1]] : [[w.x1 - 1, u], [w.x1, u]]);
        if (horizontal) r.fillRect(u * px, w.y1 * px - t / 2, px, t, gap);
        else r.fillRect(w.x1 * px - t / 2, u * px, t, px, gap);
      } else if (horizontal) r.fillRect(u * px, w.y1 * px - t / 2, px, t, colour);
      else r.fillRect(w.x1 * px - t / 2, u * px, t, px, colour);
    }
  }
  return r.toPng();
}

const ROOF_LINE: Rgba = [150, 150, 150, 255];
const ROOF_CHIMNEY: Rgba = [70, 70, 70, 255];

/**
 * One roof over one wing, at scene size. `mask` is pure white (under this roof, eave included) on black, and
 * is also the roof's transparency; `guide` is the same plus thin grey roof lines (ridges, hips) and dark
 * chimney squares for the painter. The eave never runs over a room of another roof.
 */
export function renderRoofWing(plan: Floorplan, roof: ResolvedRoof, others: ResolvedRoof[] = []): { guide: Buffer; mask: Buffer } {
  const px = plan.pxPerCell;
  const eave = roof.eaveCells * px;
  const draw = (withLines: boolean): Buffer => {
    const r = new Raster(plan.cols * px, plan.rows * px);
    r.fillRect(0, 0, r.width, r.height, [0, 0, 0, 255]);
    for (const f of roof.rects) r.fillRect(f.x * px - eave, f.y * px - eave, f.w * px + 2 * eave, f.h * px + 2 * eave, [255, 255, 255, 255]);
    for (const o of others) for (const f of o.rects) r.fillRect(f.x * px, f.y * px, f.w * px, f.h * px, [0, 0, 0, 255]);
    if (!withLines) return r.toPng();
    const line = Math.max(2, Math.round(px * 0.04));
    for (const f of roof.rects) {
      const x0 = f.x * px, y0 = f.y * px, w = f.w * px, h = f.h * px;
      const cx = x0 + w / 2, cy = y0 + h / 2;
      const along = roof.ridge ? roof.ridge === "ew" : w >= h; // ridge runs east-west when true
      if (roof.shape === "flat") continue;
      if (roof.shape === "conical") {
        for (let k = 0; k < 8; k++) r.drawLine(cx, cy, cx + Math.cos((k * Math.PI) / 4) * (Math.min(w, h) / 2), cy + Math.sin((k * Math.PI) / 4) * (Math.min(w, h) / 2), line, ROOF_LINE);
      } else if (roof.shape === "domed") {
        const rad = Math.min(w, h) / 2;
        for (const k of [1, 0.66, 0.33]) for (let a = 0; a < 72; a++) r.fillCircle(cx + Math.cos((a * Math.PI) / 36) * rad * k, cy + Math.sin((a * Math.PI) / 36) * rad * k, line / 2, ROOF_LINE);
      } else {
        // gabled (or unspecified): one ridge along the long axis; hipped: shorter ridge plus four hips to the corners.
        const inset = roof.shape === "hipped" ? Math.min(w, h) / 2 : px * 0.25;
        const rx1 = along ? x0 + inset : cx, rx2 = along ? x0 + w - inset : cx;
        const ry1 = along ? cy : y0 + inset, ry2 = along ? cy : y0 + h - inset;
        r.drawLine(rx1, ry1, rx2, ry2, line, ROOF_LINE);
        if (roof.shape === "hipped") {
          r.drawLine(x0, y0, rx1, ry1, line, ROOF_LINE);
          r.drawLine(x0 + w, y0, rx2, ry1, line, ROOF_LINE);
          r.drawLine(x0, y0 + h, rx1, ry2, line, ROOF_LINE);
          r.drawLine(x0 + w, y0 + h, rx2, ry2, line, ROOF_LINE);
        }
      }
    }
    const chim = Math.round(px * 0.4);
    for (const c of roof.chimneys) r.fillRect(c.col * px + (px - chim) / 2, c.row * px + (px - chim) / 2, chim, chim, ROOF_CHIMNEY);
    return r.toPng();
  };
  return { guide: draw(true), mask: draw(false) };
}

const OV_WALL: Rgba = [255, 40, 40, 255];
const OV_DOOR: Rgba = [40, 220, 80, 255];
const OV_WINDOW: Rgba = [40, 200, 255, 255];
const OV_LIGHT: Rgba = [255, 230, 40, 255];

/** Transparent overlay: red walls, green doors, cyan windows, yellow lights, magenta stairs. */
export function renderOverlay(plan: Floorplan, walls: WallSegment[], lights: PlacedLight[], stairs: PlacedStair[] = []): Buffer {
  const px = plan.pxPerCell;
  const r = new Raster(plan.cols * px, plan.rows * px);
  for (const w of walls) {
    const colour = w.kind === "door" || w.kind === "secretDoor" ? OV_DOOR : w.kind === "window" ? OV_WINDOW : OV_WALL;
    drawSegment(r, w, px, 6, colour);
  }
  drawStairs(r, stairs, px, true);
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

/** Pixel size of any image ImageMagick can read (the picture may be a webp: no PNG header to parse). */
export async function imageSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await run("magick", ["identify", "-format", "%w %h", file]);
    const [w, h] = stdout.trim().split(" ").map(Number);
    return w && h ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

/** Make everything outside the footprint transparent: the guide's white is opaque, its black is clear. */
export async function maskToFootprint(picture: string, maskPng: string, out: string): Promise<void> {
  await run("magick", [picture, "(", maskPng, "-alpha", "off", "-colorspace", "Gray", ")", "-compose", "CopyOpacity", "-composite", out]);
}
