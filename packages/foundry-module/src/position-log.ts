/**
 * Session position log: once a minute, where every connected player is — the scene they
 * are viewing, their token(s), the regions each token stands in, the nearest map pin, the
 * level and whether the token is hidden — sent to a local collector over HTTP.
 *
 * The collector is the vault's `dnd-whisper/scripts/position-collector.mjs`, which
 * `run-session.sh` starts beside the session recording and stops when the recording ends.
 * So the module needs no click and no AI round-trip: whenever that collector answers, rows
 * flow; when it does not (no recording tonight), each minute's row is simply dropped.
 * Rows that fail to send after the collector has answered once are kept (capped) and
 * resent, and the collector drops duplicates by timestamp.
 *
 * Kept off the relay on purpose: the relay port belongs to the MCP server, which may or
 * may not be running during play, and position logging must not depend on it.
 *
 * `snapshotPositions` reads only the `game`-shaped object it is handed, so it is unit-tested
 * with plain objects; `PositionLogger` takes `fetch`, the clock and the timer by injection.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const POSITION_SCHEMA = "lob-session-positions-v1";
export const DEFAULT_POSITION_LOG_URL = "http://localhost:8789";
export const POSITION_INTERVAL_MS = 60_000;
/**
 * Rows kept for resend while the collector is unreachable mid-session. Short on purpose: a
 * collector that stays away longer has most likely stopped with the recording, and a long
 * backlog would land in the next evening's log.
 */
export const MAX_PENDING_ROWS = 15;

export interface TokenPosition {
  token: string | null;
  actor: string | null;
  hidden: boolean;
  x: number;
  y: number;
  elevation: number;
  level: string | null;
  regions: string[];
  nearestPin: string | null;
  pinSquares: number | null;
}

export interface PlayerPosition {
  user: string;
  character: string | null;
  viewedScene: string | null;
  tokenScene: string | null;
  tokens: TokenPosition[];
}

export interface PositionRow {
  t: number;
  iso: string;
  activeScene: { id: string; name: string } | null;
  players: PlayerPosition[];
  offline: string[];
}

const list = (c: any): any[] => {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  try {
    return [...c];
  } catch {
    return [];
  }
};
const sceneName = (s: any): string => String(s?.navName || s?.name || s?.id || "?");
const sceneById = (game: any, id: unknown): any => (id ? (game.scenes?.get?.(id) ?? null) : null);

function center(t: any, scene: any): { x: number; y: number; elevation: number } {
  const g = Number(scene?.grid?.size) || 100;
  return {
    x: Number(t.x ?? 0) + (Number(t.width) || 1) * g / 2,
    y: Number(t.y ?? 0) + (Number(t.height) || 1) * g / 2,
    elevation: Number(t.elevation) || 0,
  };
}

/** Regions the token stands in: Foundry's own tagging first, point tests as the fallback. */
function regionsAt(t: any, scene: any, p: { x: number; y: number; elevation: number }): string[] {
  const names = new Set<string>();
  try {
    for (const r of list(t.regions)) if (r?.name) names.add(String(r.name));
  } catch {
    /* not tagged */
  }
  if (!names.size) {
    for (const r of list(scene?.regions)) {
      try {
        if (r?.name && typeof r.testPoint === "function" && r.testPoint(p, p.elevation)) names.add(String(r.name));
      } catch {
        /* a region whose shape cannot be tested off-canvas */
      }
    }
  }
  return [...names];
}

/** The nearest map pin — room pins are journal pages named after the room. */
function nearestPin(scene: any, p: { x: number; y: number }): { name: string; squares: number } | null {
  let best: { name: string; d: number } | null = null;
  for (const n of list(scene?.notes)) {
    const label = n?.text || n?.page?.name || n?.entry?.name;
    if (!label) continue;
    const d = Math.hypot(Number(n.x) - p.x, Number(n.y) - p.y);
    if (!best || d < best.d) best = { name: String(label), d };
  }
  if (!best) return null;
  const g = Number(scene?.grid?.size) || 100;
  return { name: best.name, squares: Math.round(best.d / g) };
}

function levelOf(t: any, scene: any): string | null {
  try {
    const id = t.level ?? t._source?.level;
    if (!id) return null;
    const lvl = scene?.levels?.get?.(id);
    return String(lvl?.name ?? id);
  } catch {
    return null;
  }
}

function ownedTokens(user: any, scene: any): any[] {
  if (!scene) return [];
  return list(scene.tokens).filter((t) => {
    const actor = t?.actor;
    if (!actor) return false;
    if (user.character?.id && actor.id === user.character.id) return true;
    try {
      return !!actor.testUserPermission?.(user, "OWNER");
    } catch {
      return false;
    }
  });
}

function describeToken(t: any, scene: any): TokenPosition {
  const p = center(t, scene);
  const pin = nearestPin(scene, p);
  return {
    token: t.name ?? null,
    actor: t.actor?.name ?? null,
    hidden: !!t.hidden,
    x: Math.round(p.x),
    y: Math.round(p.y),
    elevation: p.elevation,
    level: levelOf(t, scene),
    regions: regionsAt(t, scene, p),
    nearestPin: pin?.name ?? null,
    pinSquares: pin?.squares ?? null,
  };
}

/** One row: every connected non-GM user's whereabouts, plus the active scene and who is offline. */
export function snapshotPositions(game: any, now: number): PositionRow {
  const active = game.scenes?.active ?? list(game.scenes).find((s) => s?.active) ?? null;
  const players = list(game.users).filter((u) => !u?.isGM);
  return {
    t: now,
    iso: new Date(now).toISOString(),
    activeScene: active ? { id: String(active.id), name: sceneName(active) } : null,
    players: players
      .filter((u) => u.active)
      .map((u) => {
        const viewed = sceneById(game, u.viewedScene);
        let scene = viewed;
        let tokens = ownedTokens(u, viewed);
        // Looking at a scene without their token: fall back to the active scene, then to any
        // scene holding their character.
        if (!tokens.length && active && active !== viewed) {
          const at = ownedTokens(u, active);
          if (at.length) {
            scene = active;
            tokens = at;
          }
        }
        if (!tokens.length && u.character?.id) {
          const elsewhere = list(game.scenes).find((s) => list(s?.tokens).some((t) => t?.actor?.id === u.character.id));
          if (elsewhere) {
            scene = elsewhere;
            tokens = ownedTokens(u, elsewhere);
          }
        }
        return {
          user: String(u.name),
          character: u.character?.name ?? null,
          viewedScene: viewed ? sceneName(viewed) : null,
          tokenScene: tokens.length ? sceneName(scene) : null,
          tokens: tokens.map((t) => describeToken(t, scene)),
        };
      }),
    offline: players.filter((u) => !u.active).map((u) => String(u.name)),
  };
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<FetchResponseLike>;

export interface PositionLoggerOptions {
  url: string;
  snapshot: (now: number) => PositionRow;
  meta: () => Record<string, unknown>;
  fetch: FetchLike;
  now?: () => number;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Called once when a collector first answers, and once when it goes away after answering. */
  onStatus?: (status: { connected: boolean; session?: string; rows?: number }) => void;
  log?: (message: string) => void;
}

export class PositionLogger {
  private readonly opts: PositionLoggerOptions;
  private pending: PositionRow[] = [];
  private session: string | null = null;
  private connected = false;
  private handle: unknown = null;
  private inFlight = false;

  constructor(opts: PositionLoggerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.handle) return;
    const every = this.opts.intervalMs ?? POSITION_INTERVAL_MS;
    const set = this.opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.handle = set(() => void this.tick(), every);
    void this.tick();
  }

  stop(): void {
    if (!this.handle) return;
    const clear = this.opts.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  get pendingRows(): number {
    return this.pending.length;
  }

  /** Take one snapshot and send it with any backlog. Never throws. */
  async tick(): Promise<void> {
    if (this.inFlight) return; // a hung request must not stack up a second one
    this.inFlight = true;
    try {
      const now = (this.opts.now ?? Date.now)();
      let row: PositionRow;
      try {
        row = this.opts.snapshot(now);
      } catch (e) {
        this.opts.log?.(`position snapshot failed: ${(e as Error).message}`);
        return;
      }
      const rows = [...this.pending, row];
      try {
        const res = await this.opts.fetch(`${this.opts.url.replace(/\/+$/, "")}/rows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...this.opts.meta(), rows }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ack = (await res.json().catch(() => ({}))) as { session?: string; rows?: number };
        this.pending = [];
        if (!this.connected || ack.session !== this.session) {
          this.connected = true;
          this.session = ack.session ?? null;
          this.opts.onStatus?.({ connected: true, session: ack.session, rows: ack.rows });
        }
      } catch {
        // No collector before it ever answered: nothing is being recorded, drop the row.
        // After it answered: keep the backlog so a blip or a collector restart loses nothing.
        if (this.connected) {
          this.pending = rows.slice(-MAX_PENDING_ROWS);
          this.connected = false;
          this.opts.onStatus?.({ connected: false });
        } else if (this.session !== null) {
          this.pending = rows.slice(-MAX_PENDING_ROWS);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}
