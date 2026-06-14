# Setup & configuration — local Foundry and The Forge

A concise guide to every configurable property and how to activate the bridge.
There are two sides to configure, and they must agree on URL + token:

- **MCP server** — read once from `.env` (or `dev.config.json` in development).
- **Foundry module** — set in the world's **Module Settings** (GM only).

> Prerequisites for real testing (beyond config): the module must be **bundled**
> into a single `dist/index.js` and installed in Foundry, and the **relay
> endpoint** at `relayUrl` must be running and reachable. See "Prerequisites"
> below. Until both exist, develop against the in-memory mock (`npm test`).

---

## 1. MCP server properties

Set via environment or `.env` (copy from [`.env.example`](../.env.example)).
This is the only place the server reads configuration.

| Property | Env var | Required | Default | What it is |
| --- | --- | --- | --- | --- |
| `relayUrl` | `RELAY_URL` | ✅ | — | WebSocket address of the relay endpoint the Foundry module connects to (e.g. `wss://relay.example.com` or `ws://localhost:8787`). Must match the module's **Relay URL**. |
| `relayToken` | `RELAY_TOKEN` | ⛔ optional* | — | Shared secret. When set, every command must carry it; the module rejects mismatches with an `AUTH` error. *Required in practice for any non-localhost relay. Must match the module's **Relay token**. |
| `requestTimeoutMs` | `RELAY_TIMEOUT_MS` | ⛔ optional | `10000` | Per-command transport timeout in milliseconds. A slow/unreachable module yields a structured `TIMEOUT` error. |

In development only, the same three properties may be supplied via
`dev.config.json` (keys `relayUrl`, `relayToken`, `requestTimeoutMs`); see
[`dev.config.example.json`](../dev.config.example.json). Environment values take
precedence. Missing `relayUrl` fails loudly at startup.

---

## 2. Foundry module settings

Registered automatically when the module loads. Configure them in Foundry under
**Game Settings → Configure Settings → Module Settings → Foundry MCP Bridge**
(world scope, GM only):

| Setting | Internal key | What it is |
| --- | --- | --- |
| **Relay URL** | `relayUrl` | WebSocket address of the relay. Must equal the server's `relayUrl`. The module connects out to this on world `ready`. |
| **Relay token** | `relayToken` | Shared secret. Must equal the server's `relayToken`. Leave empty only for a trusted localhost relay. |

The module **only** connects when the current user is a **GM**
(`game.user.isGM`). Non-GM clients never open the relay.

---

## 3. Activate on a local Foundry

1. Build a loadable module bundle (see Prerequisites) so
   `packages/foundry-module/dist/index.js` is self-contained.
2. Make Foundry see the module: copy or symlink the `packages/foundry-module`
   folder (containing `module.json` and `dist/`) into your Foundry data dir at
   `Data/modules/foundry-mcp-bridge`. (Alternatively install via a manifest URL
   pointing at `module.json`.)
3. In Foundry: **Manage Modules → enable "Foundry MCP Bridge"** in your world.
4. Open **Module Settings** and set **Relay URL** + **Relay token**.
5. Start the relay endpoint and the MCP server with matching `RELAY_URL` /
   `RELAY_TOKEN`.
6. Reload the world **as the GM**. You should see a "relay connected"
   notification in the console. The AI's tools now act on this live world.

---

## 4. Activate on The Forge

The module runs in the **GM's browser**, so it connects *outbound* to your relay
the same way as local — no inbound port to your Foundry is needed.

1. Install the module on your Forge game: **Forge → Game Configuration →
   Modules → Install/Upload** (upload the bundled module, or install from a
   manifest URL).
2. Enable it in the world and set **Relay URL** + **Relay token** as above.
3. **Mixed content:** Forge serves the world over HTTPS, so an insecure
   `ws://` relay on a remote host is blocked by the browser. Use a TLS relay
   (`wss://`). Exception: browsers treat `ws://localhost` as secure, so a relay
   on the GM's own machine works even from the HTTPS Forge tab.
4. **Asset uploads** are automatic: when running on The Forge the module uploads
   via `FilePicker.upload("forgevtt", …)` (Forge bucket); locally it uses the
   `"data"` source. No extra configuration.

---

## 5. Prerequisites (code, not yet shipped)

These are the only non-config pieces required for real-Foundry testing:

- **Module bundle** — add an esbuild step producing a single
  `packages/foundry-module/dist/index.js` with `shared` inlined, so Foundry can
  load it in the browser.
- **Relay endpoint** — a WebSocket server both ends use. Recommended: host it in
  the MCP server so the module connects directly to `relayUrl` (no third
  process). Correlate request/response by envelope `id` (already implemented in
  `WebSocketRelayTransport`).

Everything else — protocol, executor, reliability pipeline, settings, tools —
is in place and tested against the mock.
