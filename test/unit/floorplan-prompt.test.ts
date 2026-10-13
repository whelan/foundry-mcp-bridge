import { describe, it, expect } from "vitest";
import { FloorplanSchema, buildGeometry } from "../../packages/shared/src/index.js";
import { buildFloorplanPrompt, buildRoofPrompt } from "../../packages/mcp-server/src/floorplan-tools.js";

const input = {
  name: "Tower", cols: 16, rows: 10, pxPerCell: 50,
  floors: [
    { name: "Ground", rooms: [{ id: "hall", name: "great hall", x: 1, y: 1, w: 8, h: 8, furnishings: ["long table"] }, { id: "kitchen", x: 9, y: 1, w: 6, h: 8 }],
      openings: [{ room: "hall", side: "w", at: 3, kind: "door" }] },
    { name: "Upstairs", rooms: [{ id: "bed", x: 1, y: 1, w: 8, h: 8, furnishings: ["four-poster bed"] }] },
  ],
  stairs: [{ at: [4, 3], dir: "e" }],
};
const plan = (over: Record<string, unknown> = {}) => FloorplanSchema.parse({ ...input, ...over });
const stairsOf = (p: ReturnType<typeof plan>) => { const g = buildGeometry(p); if (!g.ok) throw new Error(g.errors.join()); return g.stairs; };

describe("buildFloorplanPrompt", () => {
  it("lists that floor's rooms and explains the stairs", () => {
    const p = plan();
    const ground = buildFloorplanPrompt(p, 0, stairsOf(p));
    expect(ground).toContain("great hall");
    expect(ground).not.toContain("four-poster");
    expect(ground).toMatch(/yellow.*staircase.*up/i);
    expect(ground).toContain("Ground");
    const up = buildFloorplanPrompt(p, 1, stairsOf(p));
    expect(up).toContain("four-poster bed");
    expect(up).toMatch(/yellow.*(top of a staircase|balustrade)/i);
  });

  it("a single-floor prompt has no stairs paragraph", () => {
    const p = FloorplanSchema.parse({ name: "S", cols: 8, rows: 6, rooms: [{ id: "a", x: 1, y: 1, w: 6, h: 4, furnishings: ["bed"] }] });
    expect(buildFloorplanPrompt(p)).not.toMatch(/staircase|storey/i);
    expect(buildFloorplanPrompt(p)).toContain("bed");
  });
});

describe("buildRoofPrompt", () => {
  it("asks for a top-down roof of the chosen style over the white shape only", () => {
    const p = buildRoofPrompt(plan({ roofStyle: "slate roof" }));
    expect(p).toContain("slate roof");
    expect(p).toMatch(/white/i);
    expect(p).toMatch(/black/i);
    expect(p).not.toMatch(/furnish/i);
  });
});
