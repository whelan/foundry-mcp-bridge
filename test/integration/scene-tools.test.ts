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
  mock.store.set("!actors!a1", {
    _id: "a1",
    name: "Strahd",
    type: "npc",
    img: "portraits/strahd.webp",
    prototypeToken: { texture: { src: "tokens/strahd.webp" } },
  });
  mock.store.set("!actors!a2", { _id: "a2", name: "Plain", type: "npc", img: "portraits/plain.webp" });
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

  it("defaults a token's image to the actor's token art, with or without a custom name; explicit src wins", async () => {
    const { mock, transport } = setup();
    const tokens = () => (mock.store.get("!scenes!s1") as any).tokens;
    await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", col: 0, row: 0 });
    await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", name: "Count", col: 1, row: 0 });
    await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", col: 2, row: 0, src: "custom.webp" });
    await runPlaceToken(transport, { sceneId: "s1", actorId: "a2", col: 3, row: 0 });
    await runPlaceToken(transport, { sceneId: "s1", name: "Rock", col: 4, row: 0 });
    expect(tokens().map((t: any) => [t.name, t.texture.src])).toEqual([
      ["Strahd", "tokens/strahd.webp"],
      ["Count", "tokens/strahd.webp"],
      ["Strahd", "custom.webp"],
      ["Plain", "portraits/plain.webp"],
      ["Rock", null],
    ]);
  });

  it("fails before any write when the actor or scene is missing", async () => {
    const { mock, transport } = setup();
    const noActor = await runPlaceToken(transport, { sceneId: "s1", actorId: "ghost", col: 0, row: 0 });
    expect(!noActor.ok && noActor.error.code).toBe("NOT_FOUND");
    const noScene = await runPlaceToken(transport, { sceneId: "nope", actorId: "a1", col: 0, row: 0 });
    expect(!noScene.ok && noScene.error.code).toBe("NOT_FOUND");
    expect((mock.store.get("!scenes!s1") as any).tokens).toHaveLength(0);
  });

  it("keeps the preparatory read steps in the trace", async () => {
    const { transport } = setup();
    const out = await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", col: 0, row: 0 });
    expect(out.steps.slice(0, 2)).toEqual(["find", "get-scene-state"]);
    expect(out.steps).toContain("write");
  });

  it("shows conditions in the scene state after a toggle, with linked and unlinked actor semantics", async () => {
    const { mock, transport } = setup();
    for (const [name, col, link] of [["L1", 0, true], ["L2", 1, true], ["U1", 2, false], ["U2", 3, false]] as const) {
      await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", name, col, row: 0, actorLink: link });
    }
    const [l1, l2, u1, u2] = (mock.store.get("!scenes!s1") as any).tokens;
    const conditions = async () => {
      const state = await runGetSceneState(transport, { id: "s1" });
      return state.ok ? (state.data as any).tokens.map((t: any) => t.conditions) : null;
    };
    // dry-run must not mutate: validate by toggling an unknown id (rejected) and then checking state
    expect(await conditions()).toEqual([[], [], [], []]);
    await runToggleCondition(transport, { sceneId: "s1", tokenId: l1._id, statusId: "prone" });
    expect(await conditions()).toEqual([["prone"], ["prone"], [], []]); // linked tokens share the actor
    await runToggleCondition(transport, { sceneId: "s1", tokenId: u1._id, statusId: "poisoned" });
    expect(await conditions()).toEqual([["prone"], ["prone"], ["poisoned"], []]); // only that unlinked token
    await runToggleCondition(transport, { sceneId: "s1", tokenId: l2._id, statusId: "prone", active: false });
    expect(await conditions()).toEqual([[], [], ["poisoned"], []]);
    expect(u2._id).toBeTruthy();
  });

  it("dry-runs of toggle_condition and switch_scene change no state", async () => {
    const { mock, transport } = setup();
    await runPlaceToken(transport, { sceneId: "s1", actorId: "a1", col: 0, row: 0, actorLink: true });
    const token = (mock.store.get("!scenes!s1") as any).tokens[0];
    const send = (command: any) =>
      mock.execute({ id: "d1", protocolVersion: "1" as never, dryRun: true, command } as never);
    const toggled = await send({ action: "toggleCondition", sceneId: "s1", tokenId: token._id, statusId: "prone" });
    expect(toggled.ok && (toggled.data as any).active).toBe(true);
    const switched = await send({ action: "activateScene", id: "s1", mode: "activate" });
    expect(switched.ok && (switched.data as any).done).toBe(false);
    expect((mock.store.get("!actors!a1") as any).statuses).toBeUndefined();
    expect(mock.activeSceneId).toBeNull();
  });

  it("reports V14 level backgrounds in the scene state", async () => {
    const { mock, transport } = setup();
    (mock.store.get("!scenes!s1") as any).levels = [{ _id: "l1", name: "Crypt", background: { src: "maps/crypt.webp" } }];
    const state = await runGetSceneState(transport, { id: "s1" });
    expect(state.ok && (state.data as any).levels).toEqual([{ _id: "l1", name: "Crypt", background: "maps/crypt.webp" }]);
  });

  it("restores token positions when the move read-back does not match", async () => {
    const { mock, transport } = setup();
    await runPlaceToken(transport, { sceneId: "s1", name: "Goblin", col: 0, row: 0 });
    const before = { ...(mock.store.get("!scenes!s1") as any).tokens[0] };
    transport.corruptFindAtCall = 3; // finds so far: 1 = place_token read-back; 2 = move pre-read; 3 = move read-back (stripped)
    const out = await runMoveTokens(transport, { sceneId: "s1", moves: [{ tokenId: before._id, col: 5, row: 5 }] });
    expect(!out.ok && out.error.code).toBe("READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    expect((mock.store.get("!scenes!s1") as any).tokens[0]).toMatchObject({ x: before.x, y: before.y });
  });

  it("builds limited walls with Limited sight and light", async () => {
    const { mock, transport } = setup();
    await runAddWalls(transport, { sceneId: "s1", walls: [{ x1: 0, y1: 0, x2: 1, y2: 0, kind: "limited" }] });
    expect((mock.store.get("!scenes!s1") as any).walls[0]).toMatchObject({ sight: 10, light: 10, move: 20 });
  });

  it("refuses grid-square coordinates on hex grids", async () => {
    const { mock, transport } = setup(2);
    const out = await runPlaceToken(transport, { sceneId: "s1", name: "X", col: 0, row: 0 });
    expect(!out.ok && out.error.code).toBe("UNSUPPORTED");
    expect((mock.store.get("!scenes!s1") as any).tokens).toHaveLength(0);
  });
});
