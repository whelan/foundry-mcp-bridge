import { describe, it, expect } from "vitest";
import {
  MAX_PENDING_ROWS,
  PositionLogger,
  snapshotPositions,
  type FetchLike,
  type PositionRow,
} from "./position-log.js";

/** A Foundry-shaped collection: iterable, with get(id). */
function coll<T extends { id: string }>(items: T[]) {
  return Object.assign([...items], { get: (id: string) => items.find((i) => i.id === id), contents: items });
}

function world() {
  const kip = { id: "a-kip", name: "Kip", testUserPermission: (u: { id: string }) => u.id === "u-dennis" };
  const pyrax = { id: "a-pyrax", name: "Pyrax", testUserPermission: (u: { id: string }) => u.id === "u-rene" };
  const manor = {
    id: "s-manor",
    name: "Manor",
    navName: "Death House",
    active: true,
    grid: { size: 100 },
    tokens: coll([
      { id: "t1", name: "Kip", actor: kip, x: 200, y: 200, width: 1, height: 1, elevation: 0, hidden: false, regions: new Set([{ name: "Foyer" }]) },
      { id: "t2", name: "Pyrax", actor: pyrax, x: 900, y: 900, width: 1, height: 1, elevation: 10, hidden: true, regions: new Set() },
    ]),
    regions: coll([{ id: "r1", name: "Stairs", testPoint: (p: { x: number }) => p.x > 800 }]),
    notes: coll([
      { id: "n1", x: 250, y: 250, text: "", page: { name: "Foyer" } },
      { id: "n2", x: 1150, y: 950, text: "Den", page: null },
    ]),
  };
  const village = { id: "s-village", name: "Village of Barovia", active: false, grid: { size: 100 }, tokens: coll([]), regions: coll([]), notes: coll([]) };
  const scenes = Object.assign(coll([manor, village]), { active: manor });
  const users = coll([
    { id: "u-gm", name: "Lars", isGM: true, active: true, viewedScene: "s-manor", character: null },
    { id: "u-dennis", name: "Dennis", isGM: false, active: true, viewedScene: "s-manor", character: kip },
    { id: "u-rene", name: "René", isGM: false, active: true, viewedScene: "s-village", character: pyrax },
    { id: "u-knud", name: "Knud Åge", isGM: false, active: false, viewedScene: null, character: null },
  ]);
  return { scenes, users };
}

describe("snapshotPositions", () => {
  it("records each connected player's scene, token, region and nearest pin", () => {
    const row = snapshotPositions(world(), Date.UTC(2026, 10, 5, 18, 0));
    expect(row.iso).toBe("2026-11-05T18:00:00.000Z");
    expect(row.activeScene).toEqual({ id: "s-manor", name: "Death House" });
    expect(row.offline).toEqual(["Knud Åge"]);
    expect(row.players.map((p) => p.user)).toEqual(["Dennis", "René"]);

    const kip = row.players[0]!;
    expect(kip).toMatchObject({ character: "Kip", viewedScene: "Death House", tokenScene: "Death House" });
    expect(kip.tokens[0]).toMatchObject({ regions: ["Foyer"], nearestPin: "Foyer", pinSquares: 0, x: 250, y: 250, hidden: false });
  });

  it("falls back to the active scene and to region point tests", () => {
    const rene = snapshotPositions(world(), 0).players[1]!;
    // Viewing the village, but the token stands in the manor.
    expect(rene.viewedScene).toBe("Village of Barovia");
    expect(rene.tokenScene).toBe("Death House");
    expect(rene.tokens[0]).toMatchObject({ regions: ["Stairs"], nearestPin: "Den", pinSquares: 2, hidden: true, elevation: 10 });
  });

  it("survives a world with no scenes", () => {
    const row = snapshotPositions({ scenes: coll([]), users: coll([{ id: "u", name: "Solo", active: true, viewedScene: null }]) }, 0);
    expect(row.activeScene).toBeNull();
    expect(row.players[0]).toMatchObject({ user: "Solo", viewedScene: null, tokenScene: null, tokens: [] });
  });
});

function row(t: number): PositionRow {
  return { t, iso: new Date(t).toISOString(), activeScene: null, players: [], offline: [] };
}

function harness(answer: () => "ok" | "down") {
  const posted: number[][] = [];
  const statuses: boolean[] = [];
  let clock = 0;
  const fetch: FetchLike = async (_url, init) => {
    if (answer() === "down") throw new Error("ECONNREFUSED");
    const body = JSON.parse(init.body) as { rows: PositionRow[] };
    posted.push(body.rows.map((r) => r.t));
    return { ok: true, status: 200, json: async () => ({ session: "session-2026-11-05", rows: posted.length }) };
  };
  const logger = new PositionLogger({
    url: "http://localhost:8789/",
    fetch,
    snapshot: (now) => row(now),
    meta: () => ({}),
    now: () => (clock += 60_000),
    onStatus: (s) => statuses.push(s.connected),
  });
  return { logger, posted, statuses };
}

describe("PositionLogger", () => {
  it("drops rows while no collector has ever answered", async () => {
    const h = harness(() => "down");
    await h.logger.tick();
    await h.logger.tick();
    expect(h.logger.pendingRows).toBe(0);
    expect(h.statuses).toEqual([]);
  });

  it("resends the backlog after a dropout, once the collector has answered", async () => {
    let state: "ok" | "down" = "ok";
    const h = harness(() => state);
    await h.logger.tick(); // 60000 sent
    state = "down";
    await h.logger.tick(); // 120000 kept
    await h.logger.tick(); // 180000 kept
    expect(h.logger.pendingRows).toBe(2);
    state = "ok";
    await h.logger.tick();
    expect(h.posted).toEqual([[60_000], [120_000, 180_000, 240_000]]);
    expect(h.logger.pendingRows).toBe(0);
    expect(h.statuses).toEqual([true, false, true]);
  });

  it("caps the backlog so one evening never leaks into the next", async () => {
    let state: "ok" | "down" = "ok";
    const h = harness(() => state);
    await h.logger.tick();
    state = "down";
    for (let i = 0; i < MAX_PENDING_ROWS + 10; i++) await h.logger.tick();
    expect(h.logger.pendingRows).toBe(MAX_PENDING_ROWS);
  });

  it("never throws when the snapshot does", async () => {
    const logger = new PositionLogger({
      url: "http://x",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      snapshot: () => {
        throw new Error("canvas not ready");
      },
      meta: () => ({}),
    });
    await expect(logger.tick()).resolves.toBeUndefined();
  });
});
