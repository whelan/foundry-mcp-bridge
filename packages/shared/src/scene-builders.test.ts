import { describe, it, expect } from "vitest";
import {
  buildScene,
  buildSceneVerify,
  buildLight,
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
