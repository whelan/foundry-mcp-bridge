import { describe, it, expect } from "vitest";
import { FloorplanSchema, buildGeometry, resolveRoofs } from "../../packages/shared/src/index.js";
import { buildFloorplanPrompt, buildRoofPrompt, buildSurroundingsText, describePlace, buildConstructionText } from "../../packages/mcp-server/src/floorplan-tools.js";

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

describe("surroundings in the prompt", () => {
  const surroundings = {
    ground: "frost-hardened mud with dead grass", mood: "misty dusk",
    features: [
      { kind: "road", x: 0, y: 12, w: 24, h: 2, note: "rutted cart road with puddles" },
      { kind: "trees", x: 18, y: 0, w: 4, h: 4 },
    ],
  };
  it("describes the ground, the mood and every feature with its colour and place (ground floor only)", () => {
    const p = plan({ cols: 24, rows: 16, surroundings });
    const ground = buildFloorplanPrompt(p, 0, stairsOf(p));
    expect(ground).toContain("frost-hardened mud with dead grass");
    expect(ground).toContain("misty dusk");
    expect(ground).toMatch(/tan-brown area is a road: rutted cart road with puddles, running east-west, in the south of the picture/);
    expect(ground).toMatch(/dark green area is trees.*north-east/);
    expect(buildFloorplanPrompt(p, 1, stairsOf(p))).not.toContain("frost-hardened");
  });
  it("adds nothing without surroundings", () => {
    expect(buildSurroundingsText(plan())).toBe("");
    expect(buildFloorplanPrompt(plan(), 0, stairsOf(plan()))).not.toContain("Surroundings");
  });
  it("describes places in words", () => {
    expect(describePlace({ kind: "well", x: 7, y: 4, w: 2, h: 2 }, 16, 10)).toBe("in the middle of the picture");
    expect(describePlace({ kind: "path", x: 0, y: 2, w: 2, h: 6 }, 16, 10)).toBe("running north-south, in the west of the picture");
  });
});

describe("construction in the prompt", () => {
  it("always says the walls between rooms are thinner and that windows are as thick as their wall", () => {
    const text = buildFloorplanPrompt(plan(), 0, stairsOf(plan()));
    expect(text).toMatch(/outer walls are about 0\.6 ft thick/);
    expect(text).toMatch(/between rooms are about 0\.3 ft thick.*thinner than the outer walls/);
    expect(text).toMatch(/exactly as thick as the wall they sit in/);
  });
  it("carries this house's materials and door and window looks", () => {
    const p = plan({ construction: { exterior: { thickness: 2, material: "fieldstone" }, interior: { thickness: 0.5, material: "wattle and daub" }, doors: { style: "metal" }, windows: { look: "arrow slits" } } });
    const text = buildConstructionText(p);
    expect(text).toContain("about 2 ft thick, fieldstone");
    expect(text).toContain("about 0.5 ft thick, wattle and daub");
    expect(text).toContain("Windows: arrow slits.");
  });
});

describe("stair styles in the prompt", () => {
  const styled = (style: string, look?: string) => plan({ stairs: [{ at: [4, 3], dir: "e", length: 3, width: style === "grand" ? 2 : 1, style, ...(look ? { look } : {}) }] });
  it("describes each style on the lower floor and at the top", () => {
    for (const [style, climb, top] of [["plain", /plain wooden staircase/, /simple wooden balustrade/], ["grand", /grand staircase.*carpet runner/, /carved balustrade.*carpeted landing/], ["stone", /rough stone staircase/, /stone parapet/], ["ladder", /steep wooden ladder/, /hatch in the floor/]] as const) {
      const p = styled(style);
      expect(buildFloorplanPrompt(p, 0, stairsOf(p))).toMatch(climb);
      expect(buildFloorplanPrompt(p, 1, stairsOf(p))).toMatch(top);
    }
  });
  it("adds the look", () => {
    const p = styled("grand", "black marble with a worn red carpet");
    expect(buildFloorplanPrompt(p, 0, stairsOf(p))).toContain("(black marble with a worn red carpet)");
  });
});

describe("roof prompts per wing", () => {
  const manor = plan({ roofs: [{ name: "tower", rooms: ["kitchen"], style: "copper roof", shape: "conical", look: "green with a weathervane", condition: "weathered", chimneys: false }, { name: "flat bit", rooms: ["hall"], shape: "flat" }] });
  const [, tower, flat] = resolveRoofs(manor).length === 3 ? resolveRoofs(manor) : [undefined, undefined, undefined] as never;
  it("says the style, condition, shape, look and what the wing is", () => {
    const text = buildRoofPrompt(manor, tower!);
    expect(text).toContain("copper roof (weathered)");
    expect(text).toContain("roof over the tower");
    expect(text).toContain("a conical roof rising to a point");
    expect(text).toContain("green with a weathervane");
    expect(text).toContain("no chimneys");
    expect(text).toContain("thin grey lines");
  });
  it("a flat roof has no roof lines to follow", () => {
    expect(buildRoofPrompt(manor, flat!)).not.toContain("grey lines");
  });
  it("the default roof still reads as before", () => {
    const base = buildRoofPrompt(plan({ roofStyle: "slate roof" }));
    expect(base).toContain("slate roof");
    expect(base).not.toContain("roof over the");
  });
});

describe("doorways in the prompt", () => {
  it("tells the painter to leave doorways empty because the game adds the doors, and has no brown door bars", () => {
    const text = buildFloorplanPrompt(plan(), 0, stairsOf(plan()));
    expect(text).toMatch(/open doorway: leave it completely empty/);
    expect(text).toMatch(/no door, door leaf, frame, hinges, curtain or threshold/);
    expect(text).toMatch(/the game adds the doors/);
    expect(text).not.toMatch(/Brown bars are doors/);
  });
  it("does not accept a painter look for doors any more (construction.doors has style and tone only)", () => {
    const p = plan({ construction: { doors: { style: "metal", tone: "rusty", look: "iron-banded" } } });
    expect(buildConstructionText(p)).not.toContain("iron-banded");
  });
});
