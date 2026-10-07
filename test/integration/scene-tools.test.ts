import { describe, it, expect } from "vitest";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import {
  runListScenes,
  runGetSceneState,
  runSwitchScene,
  runPlaceToken,
  runMoveTokens,
  runRemoveTokens,
  runToggleCondition,
  runAddWalls,
  runAddLights,
} from "../../packages/mcp-server/src/scene-tools.js";

function setup(gridType = 1) {
  const mock = new MockFoundry();
  const transport = new MockTransport(mock);
  mock.store.set("!scenes!s1", {
    _id: "s1",
    name: "Crypt",
    width: 2000,
    height: 1000,
    padding: 0.25,
    grid: { type: gridType, size: 100, distance: 5, units: "ft" },
    tokens: [],
    walls: [],
    lights: [],
  });
  mock.store.set("!actors!a1", { _id: "a1", name: "Strahd", type: "npc" });
  return { mock, transport };
}

// padding 0.25 * 2000 = 500 -> origin x 500; 0.25 * 1000 = 250 -> ceil to 300
const ORIGIN = { x: 500, y: 300 };

describe("scene tools", () => {
  it("lists scenes and switches the active one", async () => {
    const { mock, transport } = setup();
    const list = await runListScenes(transport);
    expect(list.ok && list.data).toEqual([{ _id: "s1", name: "Crypt", active: false, grid: 100, size: [2000, 1000], tokens: 0 }]);
    const sw = await runSwitchScene(transport, { id: "s1", mode: "activate" });
    expect(sw.ok).toBe(true);
    expect(sw.steps).toEqual(["dry-run", "write"]);
    expect(mock.activeSceneId).toBe("s1");
    const missing = await runSwitchScene(transport, { id: "nope" });
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
  });

  it("places a token on a grid square using the actor's name, with read-back", async () => {
    const { mock, transport } = setup();
    const out = await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", col: 2, row: 1, disposition: "friendly" });
    expect(out.ok).toBe(true);
    expect(out.steps).toContain("read-back");
    const tokens = (mock.store.get("!scenes!s1") as any).tokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ name: "Strahd", actorId: "a1", x: ORIGIN.x + 200, y: ORIGIN.y + 100, disposition: 1 });
  });

  it("moves and removes tokens", async () => {
    const { mock, transport } = setup();
    await runPlaceToken(transport, { sceneId: "s1", name: "Goblin", col: 0, row: 0 });
    const id = (mock.store.get("!scenes!s1") as any).tokens[0]._id;
    const moved = await runMoveTokens(transport, { sceneId: "s1", moves: [{ tokenId: id, col: 3, row: 4 }] });
    expect(moved.ok).toBe(true);
    expect((mock.store.get("!scenes!s1") as any).tokens[0]).toMatchObject({ x: ORIGIN.x + 300, y: ORIGIN.y + 400 });
    const removed = await runRemoveTokens(transport, { sceneId: "s1", tokenIds: [id] });
    expect(removed.ok).toBe(true);
    expect((mock.store.get("!scenes!s1") as any).tokens).toHaveLength(0);
  });

  it("toggles conditions, rejects unknown ones and tokens without actors", async () => {
    const { mock, transport } = setup();
    await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", col: 0, row: 0 });
    await runPlaceToken(transport, { sceneId: "s1", name: "Rock", col: 1, row: 0 });
    const [withActor, bare] = (mock.store.get("!scenes!s1") as any).tokens;
    const on = await runToggleCondition(transport, { sceneId: "s1", tokenId: withActor._id, statusId: "prone" });
    expect(on.ok && on.data).toMatchObject({ active: true });
    const flip = await runToggleCondition(transport, { sceneId: "s1", tokenId: withActor._id, statusId: "prone" });
    expect(flip.ok && flip.data).toMatchObject({ active: false });
    const bad = await runToggleCondition(transport, { sceneId: "s1", tokenId: withActor._id, statusId: "glittery" });
    expect(!bad.ok && bad.error.code).toBe("VALIDATION");
    const noActor = await runToggleCondition(transport, { sceneId: "s1", tokenId: bare._id, statusId: "prone" });
    expect(!noActor.ok && noActor.error.code).toBe("VALIDATION");
  });

  it("adds walls and lights from grid coordinates and reports them in the scene state", async () => {
    const { transport } = setup();
    const walls = await runAddWalls(transport, { sceneId: "s1", walls: [{ x1: 0, y1: 0, x2: 4, y2: 0, kind: "door" }] });
    expect(walls.ok).toBe(true);
    const lights = await runAddLights(transport, { sceneId: "s1", lights: [{ col: 1.5, row: 1.5, bright: 20, dim: 40 }] });
    expect(lights.ok).toBe(true);
    const state = await runGetSceneState(transport, { id: "s1" });
    expect(state.ok).toBe(true);
    if (state.ok) {
      const s = state.data as any;
      expect(s.walls[0]).toMatchObject({ c: [500, 300, 900, 300], door: 1 });
      expect(s.lights[0]).toMatchObject({ x: 650, y: 450, bright: 20, dim: 40 });
      expect(s.grid.size).toBe(100);
    }
  });

  it("refuses grid-square coordinates on hex grids", async () => {
    const { transport } = setup(2);
    const out = await runPlaceToken(transport, { sceneId: "s1", name: "X", col: 0, row: 0 });
    expect(!out.ok && out.error.code).toBe("UNSUPPORTED");
  });
});
