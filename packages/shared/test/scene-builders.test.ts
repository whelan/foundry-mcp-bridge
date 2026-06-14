import { describe, it, expect } from "vitest";
import {
  randomId,
  buildScene,
  buildLight,
  buildToken,
  buildNote,
  type ActorRef,
  type JournalRef,
} from "../src/scene-builders.js";

describe("randomId", () => {
  it("produces a 16-char alphanumeric id by default", () => {
    const id = randomId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("respects a custom length and is non-repeating", () => {
    expect(randomId(8)).toHaveLength(8);
    expect(randomId()).not.toBe(randomId());
  });
});

describe("buildScene", () => {
  it("applies V14 defaults and never emits a LevelDB _key", () => {
    const scene = buildScene({ name: "Test" }, "worlds/x/assets/bg.webp");
    expect(scene).toMatchObject({
      name: "Test",
      width: 2000,
      height: 1400,
      active: false,
    });
    expect((scene["background"] as Record<string, unknown>)["src"]).toBe("worlds/x/assets/bg.webp");
    // embedded collections are written separately, so the base scene keeps them empty
    expect(scene["tokens"]).toEqual([]);
    expect(scene["lights"]).toEqual([]);
    expect(scene).not.toHaveProperty("_key");
    expect(scene).not.toHaveProperty("_id");
  });

  it("passes through grid + environment overrides", () => {
    const scene = buildScene(
      { name: "Dark", grid: { type: 1, size: 70 }, environment: { darknessLevel: 0.9, globalLight: false } },
      null,
    );
    expect((scene["grid"] as Record<string, unknown>)["type"]).toBe(1);
    expect((scene["grid"] as Record<string, unknown>)["size"]).toBe(70);
    const envGlobal = (scene["environment"] as Record<string, unknown>)["globalLight"] as Record<string, unknown>;
    expect(envGlobal["enabled"]).toBe(false);
  });
});

describe("buildLight", () => {
  it("maps spec fields into the V14 light.config shape", () => {
    const light = buildLight({ x: 1000, y: 822, dim: 25, bright: 10, color: "#ff9329", animation: { type: "torch", speed: 2 } });
    expect(light["x"]).toBe(1000);
    const config = light["config"] as Record<string, unknown>;
    expect(config["dim"]).toBe(25);
    expect(config["bright"]).toBe(10);
    expect((config["animation"] as Record<string, unknown>)["type"]).toBe("torch");
    expect(light).toHaveProperty("_id");
  });
});

describe("buildToken", () => {
  it("links to the actor and layers placement on the prototype token", () => {
    const actor: ActorRef = { _id: "abc123", name: "Goran", prototypeToken: { texture: { src: "g.webp" }, actorLink: true } };
    const token = buildToken({ x: 1510, y: 480, hidden: true, disposition: 0 }, actor);
    expect(token["actorId"]).toBe("abc123");
    expect(token["name"]).toBe("Goran");
    expect(token["x"]).toBe(1510);
    expect(token["hidden"]).toBe(true);
    expect(token["actorLink"]).toBe(true);
    expect((token["texture"] as Record<string, unknown>)["src"]).toBe("g.webp");
    expect(token["delta"]).toEqual({});
  });
});

describe("buildNote", () => {
  it("references the journal entry and first page", () => {
    const journal: JournalRef = { _id: "jrn1", name: "Lejren", firstPageId: "page1" };
    const note = buildNote({ x: 1000, y: 740, text: "Lejren" }, journal);
    expect(note["entryId"]).toBe("jrn1");
    expect(note["pageId"]).toBe("page1");
    expect(note["text"]).toBe("Lejren");
  });

  it("falls back to the journal name and a null page", () => {
    const note = buildNote({}, { _id: "jrn2", name: "Krypten" });
    expect(note["text"]).toBe("Krypten");
    expect(note["pageId"]).toBeNull();
  });
});
