/**
 * Foundry module entry point. Registers settings, and on `ready` — GM only —
 * opens the relay and starts executing inbound commands against this world.
 *
 * All wiring here touches Foundry globals and is not run in CI; the behaviour it
 * composes (executor, relay client) is unit-tested against the mock.
 */

import { RelayClient } from "./relay-client.js";
import {
  MODULE_ID,
  createFoundryRuntimeApi,
  ensureWorldKey,
  readPermissionLevel,
  readSettings,
  registerSettings,
} from "./foundry-runtime.js";

export { RelayClient } from "./relay-client.js";
export * from "./protocol-executor.js";
export {
  MODULE_ID,
  createFoundryRuntimeApi,
  readSettings,
  registerSettings,
} from "./foundry-runtime.js";

let client: RelayClient | null = null;

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
});

Hooks.once("closeGame", () => {
  client?.disconnect();
  client = null;
});

/** Append the relay token as a query param so the relay can authenticate us. */
function withToken(url: string, token?: string): string {
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
