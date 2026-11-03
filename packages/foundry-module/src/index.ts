/**
 * Foundry module entry point. Registers settings, and on `ready` — GM only —
 * opens the relay and starts executing inbound commands against this world.
 *
 * All wiring here touches Foundry globals and is not run in CI; the behaviour it
 * composes (executor, relay client) is unit-tested against the mock.
 */

import { RelayClient } from "./relay-client.js";
import { PositionLogger, POSITION_INTERVAL_MS, snapshotPositions, type FetchLike } from "./position-log.js";
import {
  MODULE_ID,
  createFoundryRuntimeApi,
  ensureWorldKey,
  readPermissionLevel,
  readSettings,
  registerSettings,
} from "./foundry-runtime.js";

export { RelayClient } from "./relay-client.js";
export * from "./position-log.js";
export * from "./protocol-executor.js";
export {
  MODULE_ID,
  createFoundryRuntimeApi,
  readSettings,
  registerSettings,
} from "./foundry-runtime.js";

let client: RelayClient | null = null;
let positions: PositionLogger | null = null;

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  // GM-only: non-GM clients never open the relay.
  if (!game.user?.isGM) return;

  let settings;
  try {
    settings = readSettings();
  } catch (e) {
    ui.notifications?.warn((e as Error).message);
    return;
  }

  void ensureWorldKey().catch((e) => console.warn(`[${MODULE_ID}] could not store the world key: ${(e as Error).message}`));

  client = new RelayClient({
    url: settings.url,
    api: createFoundryRuntimeApi(),
    context: { isGM: true, expectedToken: settings.token, permissionLevel: readPermissionLevel },
    createSocket: (url) => new WebSocket(withToken(url, settings.token)),
    log: (level, message) => console[level === "error" ? "error" : "log"](`[${MODULE_ID}] ${message}`),
  });
  client.connect();

  startPositionLog();
});

/**
 * The session position log runs beside the relay, not through it: it posts to the local
 * collector run-session.sh starts with the recording, and is silent whenever nothing answers.
 * Exposed on the module's `api` so the vault's fallback macro can see it is already running.
 */
function startPositionLog(): void {
  let url = "";
  try {
    url = String(game.settings.get(MODULE_ID, "positionLogUrl") ?? "").trim();
  } catch {
    return;
  }
  if (!url) return;
  const fetchFn = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!fetchFn) return;
  positions = new PositionLogger({
    url,
    fetch: (u, init) => fetchFn(u, init),
    snapshot: (now) => snapshotPositions(game, now),
    meta: () => ({
      world: { id: game.world?.id, title: game.world?.title },
      foundryVersion: game.version,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      intervalMs: POSITION_INTERVAL_MS,
      source: MODULE_ID,
    }),
    onStatus: ({ connected, session, rows }) => {
      if (connected) ui.notifications?.info(`Session position log → ${session ?? "recording"} (${rows ?? 0} rows).`);
      else ui.notifications?.warn("Session position log: the recording's collector stopped answering.");
    },
    log: (m) => console.warn(`[${MODULE_ID}] ${m}`),
  });
  positions.start();
  const mod = game.modules?.get?.(MODULE_ID);
  if (mod) mod.api = { ...(mod.api ?? {}), positionLogger: positions };
}

Hooks.once("closeGame", () => {
  client?.disconnect();
  client = null;
  positions?.stop();
  positions = null;
});

/** Append the relay token as a query param so the relay can authenticate us. */
function withToken(url: string, token?: string): string {
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
