import { describe, it, expect } from "vitest";
import {
  buildScene,
  buildSceneVerify,
  buildLight,
  buildWallFromGrid,
  resolveLightInput,
  LIGHT_PRESETS,
  buildToken,
  buildNote,
  randomID,
  GRID_TYPES,
  TOKEN_DISPOSITIONS,
} from "./scene-builders.js";
import { deepMerge } from "./objects.js";

describe("randomID", () => {
  it("produces 16-char alphanumeric ids that differ", () => {
    const a = randomID();
    const b = randomID();
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(a).not.toEqual(b);
  });
});

describe("deepMerge", () => {
  it("merges nested objects but replaces arrays", () => {
    const merged = deepMerge(
      { grid: { size: 100, type: 1 }, tokens: [1, 2] },
      { grid: { size: 200 }, tokens: [9] },
    );
    expect(merged).toEqual({ grid: { size: 200, type: 1 }, tokens: [9] });
  });
});

describe("buildScene", () => {
  it("builds a scene with grid as an object", () => {
    const scene = buildScene({ name: "Tavern" });
    expect(scene.name).toBe("Tavern");
    expect(scene.grid).toMatchObject({ type: GRID_TYPES.SQUARE, size: 100 });
    expect(Array.isArray(scene.tokens)).toBe(true);
    expect(Array.isArray(scene.lights)).toBe(true);
  });

  it("omits backgroundColor and background when not provided", () => {
    const scene = buildScene({ name: "Tavern" });
    expect("backgroundColor" in scene).toBe(false);
    expect("background" in scene).toBe(false);
    expect("initial" in scene).toBe(false);
  });

  it("includes backgroundColor and background only when explicitly set", () => {
    const scene = buildScene({ name: "Tavern", backgroundColor: "#ff0000", background: "img/bg.webp" });
    expect(scene.backgroundColor).toBe("#ff0000");
    expect(scene.background).toEqual({ src: "img/bg.webp" });
  });

  it("deep-merges overrides into nested grid", () => {
    const scene = buildScene({ name: "Cave", gridSize: 70 }, { grid: { units: "m" } });
    expect(scene.grid).toMatchObject({ size: 70, units: "m" });
  });

  it("embeds provided tokens/lights/notes", () => {
    const token = buildToken({ name: "Goblin", x: 0, y: 0 });
    const scene = buildScene({ name: "Field", tokens: [token] });
    expect((scene.tokens as unknown[]).length).toBe(1);
  });
});

describe("buildSceneVerify", () => {
  it("returns only version-stable fields (name, dimensions, grid)", () => {
    const verify = buildSceneVerify({ name: "Arena", width: 1000, height: 800, gridSize: 100 });
    expect(verify).toMatchObject({ name: "Arena", width: 1000, height: 800 });
    expect(verify.grid).toMatchObject({ size: 100 });
    expect("backgroundColor" in verify).toBe(false);
    expect("background" in verify).toBe(false);
    expect("initial" in verify).toBe(false);
    expect("tokens" in verify).toBe(false);
  });

  it("uses the same defaults as buildScene for grid fields", () => {
    const full = buildScene({ name: "X" });
    const verify = buildSceneVerify({ name: "X" });
    expect(verify.grid).toEqual(full.grid);
    expect(verify.width).toBe(full.width);
    expect(verify.height).toBe(full.height);
    expect(verify.padding).toBe(full.padding);
  });
});

describe("buildLight", () => {
  it("nests light parameters under config (V14)", () => {
    const light = buildLight({ x: 10, y: 20, bright: 20, dim: 40, color: "#ff0000" });
    expect(light).toMatchObject({ x: 10, y: 20 });
    expect(light.config).toMatchObject({ bright: 20, dim: 40, color: "#ff0000" });
    expect(typeof light._id).toBe("string");
  });
});

describe("buildToken", () => {
  it("nests the image under texture.src and defaults to hostile", () => {
    const token = buildToken({ name: "Orc", x: 1, y: 2, src: "orc.png" });
    expect(token).toMatchObject({ name: "Orc", disposition: TOKEN_DISPOSITIONS.HOSTILE });
    expect(token.texture).toMatchObject({ src: "orc.png" });
  });
});

describe("buildNote", () => {
  it("defaults entryId to null and accepts a linked entry", () => {
    const blank = buildNote({ x: 0, y: 0 });
    expect(blank.entryId).toBeNull();
    const linked = buildNote({ x: 0, y: 0, entryId: "j1", text: "Here" });
    expect(linked).toMatchObject({ entryId: "j1", text: "Here" });
  });
});

describe("grid helpers", () => {
  it("converts squares to pixels and back, honouring the origin", async () => {
    const { gridToPixels, pixelsToGrid } = await import("./scene-builders.js");
    const origin = { x: 500, y: 300 };
    const p = gridToPixels(3, 2, 100, origin);
    expect(p).toEqual({ x: 800, y: 500 });
    expect(pixelsToGrid(p.x + 40, p.y + 99, 100, origin)).toEqual({ col: 3, row: 2 });
  });

  it("builds wall, door, secretDoor and limited walls with named constants", async () => {
    const { buildWallFromGrid } = await import("./scene-builders.js");
    const seg = { x1: 0, y1: 0, x2: 1, y2: 0 };
    expect(buildWallFromGrid(seg, 100)).toMatchObject({ c: [0, 0, 100, 0], door: 0, move: 20, sight: 20, light: 20 });
    expect(buildWallFromGrid({ ...seg, kind: "door" }, 100)).toMatchObject({ door: 1, sight: 20 });
    expect(buildWallFromGrid({ ...seg, kind: "secretDoor" }, 100)).toMatchObject({ door: 2 });
    expect(buildWallFromGrid({ ...seg, kind: "limited" }, 100)).toMatchObject({ door: 0, move: 20, sight: 10, light: 10 });
  });

  it("normalises V13 and V14 scene backgrounds in the scene state", async () => {
    const { buildSceneState } = await import("./scene-builders.js");
    const facts = { active: false, origin: { x: 0, y: 0 }, conditions: {} };
    const base = { _id: "s", name: "S", width: 1, height: 1, grid: { type: 1, size: 100 } };
    expect(buildSceneState({ ...base, background: { src: "a.webp" } }, facts)).toMatchObject({ background: "a.webp", levels: [] });
    expect(buildSceneState(base, facts)).toMatchObject({ background: null, levels: [] });
    const v14 = buildSceneState(
      { ...base, levels: [{ _id: "l1", name: "Cellar", background: { src: "c.webp" } }, { _id: "l2", background: {} }] },
      facts,
    );
    expect(v14.background).toBeNull();
    expect(v14.levels).toEqual([{ _id: "l1", name: "Cellar", background: "c.webp" }, { _id: "l2", background: null }]);
  });
});

describe("buildWallFromGrid: windows and doors", () => {
  it("makes a window that blocks movement but not sight or light", () => {
    const w = buildWallFromGrid({ x1: 0, y1: 0, x2: 2, y2: 0, kind: "window" }, 100, {});
    expect(w).toMatchObject({ door: 0, move: 20, sight: 0, light: 0, sound: 20, c: [0, 0, 200, 0] });
  });

  it("animates a plain door: swing, with a wood texture from core", () => {
    const d = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door" }, 100, {});
    expect(d.animation).toMatchObject({ type: "swing", double: false, direction: 1, flip: false, duration: 750, strength: 1 });
    expect((d.animation as { texture: string }).texture).toMatch(/^canvas\/doors\/small\/Door_Wood_/);
    expect(d.ds).toBe(0);
  });

  it("gives a secret door no animation, it must look like wall", () => {
    const d = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "secretDoor" }, 100, {});
    expect(d.animation).toBeUndefined();
  });

  it("writes the v14 animation block, with a 2x1 texture for a double door", () => {
    const d = buildWallFromGrid(
      { x1: 0, y1: 0, x2: 2, y2: 0, kind: "door", doorOptions: { animation: "slide", double: true } },
      100,
      {},
    );
    expect(d.animation).toMatchObject({ type: "slide", direction: 1, double: true, flip: false, duration: 750, strength: 1 });
    expect((d.animation as { texture: string }).texture).toMatch(/^canvas\/doors\/large\//);
  });

  it("a style picks the texture and its fitting animation", () => {
    const gate = buildWallFromGrid({ x1: 0, y1: 0, x2: 2, y2: 0, kind: "door", doorOptions: { style: "portcullis" } }, 100, {});
    expect(gate.animation).toMatchObject({ type: "ascend", double: true });
    expect((gate.animation as { texture: string }).texture).toMatch(/Portcullis_/);
    const stone = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door", doorOptions: { style: "stone" } }, 100, {});
    expect(stone.animation).toMatchObject({ type: "slide" });
    expect((stone.animation as { texture: string }).texture).toMatch(/Door_Stone_/);
  });

  it("an explicit texture path wins over the style", () => {
    const d = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door", doorOptions: { texture: "worlds/w/my-door.webp" } }, 100, {});
    expect((d.animation as { texture: string }).texture).toBe("worlds/w/my-door.webp");
  });

  it("different doors in one house get varied textures", () => {
    const paths = new Set(
      [0, 1, 2, 3, 4, 5].map((x) => (buildWallFromGrid({ x1: x * 2, y1: 3, x2: x * 2 + 1, y2: 3, kind: "door" }, 100, {}).animation as { texture: string }).texture),
    );
    expect(paths.size).toBeGreaterThan(1);
  });

  it("locks and opens doors through ds", () => {
    const locked = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door", doorOptions: { locked: true } }, 100, {});
    const open = buildWallFromGrid({ x1: 0, y1: 0, x2: 1, y2: 0, kind: "door", doorOptions: { open: true } }, 100, {});
    expect([locked.ds, open.ds]).toEqual([2, 1]);
  });
});

describe("light presets", () => {
  it("a fireplace flickers with the flame animation", () => {
    const l = resolveLightInput({ source: "fireplace" });
    expect(l).toMatchObject({ bright: 15, dim: 30, color: "#ff7a2e", animation: { type: "flame" } });
  });

  it("explicit values override the preset", () => {
    const l = resolveLightInput({ source: "torch", bright: 30, color: "#ffffff", animation: "pulse" });
    expect(l).toMatchObject({ bright: 30, dim: 40, color: "#ffffff", animation: { type: "pulse" } });
  });

  it("no source and no values means no light radius and no animation", () => {
    expect(resolveLightInput({})).toEqual({ bright: 0, dim: 0, color: null, animation: { type: null, speed: 5, intensity: 5 } });
  });

  it("has a preset for every documented source", () => {
    expect(Object.keys(LIGHT_PRESETS).sort()).toEqual(["candle", "daylight", "fireplace", "lantern", "torch"]);
  });
});
