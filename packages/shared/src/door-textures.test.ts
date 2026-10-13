import { describe, it, expect } from "vitest";
import { DOOR_TEXTURES, DOOR_STYLES, pickDoorTexture, defaultDoorAnimation } from "./door-textures.js";

describe("door texture catalog", () => {
  it("lists the 30 images Foundry ships under canvas/doors, each once", () => {
    expect(DOOR_TEXTURES).toHaveLength(30);
    expect(new Set(DOOR_TEXTURES.map((t) => t.path)).size).toBe(30);
    for (const t of DOOR_TEXTURES) expect(t.path).toMatch(/^canvas\/doors\/(small|large)\/[A-Za-z0-9_]+\.webp$/);
  });

  it("small images are single doors and large images are double (2x1)", () => {
    for (const t of DOOR_TEXTURES) expect(t.path.includes("/large/")).toBe(t.wide);
  });

  it("every style has at least one single and, except stone/metal, a wide texture", () => {
    for (const s of DOOR_STYLES) expect(DOOR_TEXTURES.some((t) => t.style === s && !t.wide) || s === "portcullis").toBe(true);
    expect(DOOR_TEXTURES.some((t) => t.style === "wood" && t.wide)).toBe(true);
    expect(DOOR_TEXTURES.some((t) => t.style === "portcullis" && t.wide)).toBe(true);
  });

  it("picks a texture of the asked style and width", () => {
    const t = pickDoorTexture("wood", { wide: true });
    expect(t.style).toBe("wood");
    expect(t.wide).toBe(true);
  });

  it("is deterministic per seed and varies across seeds", () => {
    expect(pickDoorTexture("wood", { seed: 3 })).toEqual(pickDoorTexture("wood", { seed: 3 }));
    const paths = new Set([0, 1, 2, 3, 4, 5, 6].map((seed) => pickDoorTexture("wood", { seed }).path));
    expect(paths.size).toBeGreaterThan(1);
  });

  it("narrows by tone when given, and falls back when the tone has no match", () => {
    expect(pickDoorTexture("wood", { tone: "dark" }).tone).toBe("dark");
    expect(pickDoorTexture("stone", { tone: "dark" }).style).toBe("stone");
  });

  it("falls back to a single door when no wide one exists for the style", () => {
    const t = pickDoorTexture("stone", { wide: true });
    expect(t.style).toBe("stone");
  });

  it("chooses a fitting animation per style", () => {
    expect(defaultDoorAnimation("portcullis")).toBe("ascend");
    expect(defaultDoorAnimation("stone")).toBe("slide");
    expect(defaultDoorAnimation("wood")).toBe("swing");
    expect(defaultDoorAnimation("metal")).toBe("swing");
  });
});
