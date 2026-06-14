# Setup & configuration — local Foundry and The Forge

A concise guide to every configurable property and how to activate the bridge.
There are two sides to configure, and they must agree on URL + token:

- **MCP server** — read once from `.env` (or `dev.config.json` in development).
- **Foundry module** — set in the world's **Module Settings** (GM only).

> The relay endpoint at `relayUrl` is **hosted by the MCP server** — start the
> MCP server and the module connects out to it. Before installing in Foundry,
> bundle the module with `npm run bundle:module`. Until you test against a real
> world, develop against the in-memory mock (`npm test`).

---

## 1. MCP server properties

Set via environment or `.env` (copy from [`.env.example`](../.env.example)).
This is the only place the server reads configuration.

| Property | Env var | Required | Default | What it is |
| --- | --- | --- | --- | --- |
| `relayUrl` | `RELAY_URL` | ✅ | — | WebSocket address the MCP server **binds** the relay to and the Foundry module connects to (e.g. `ws://localhost:8787`, or `wss://…` behind a TLS proxy). Host/port/path are parsed from this URL. Must match the module's **Relay URL**. |
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

1. Build the loadable bundle: `npm run bundle:module`. This produces a
   self-contained `packages/foundry-module/dist/index.js` (shared + zod inlined).
2. Make Foundry see the module: copy or symlink the `packages/foundry-module`
   folder (it must contain `module.json` and `dist/index.js`) into your Foundry
   data dir at `Data/modules/foundry-mcp-bridge`. (Alternatively install via a
   manifest URL pointing at `module.json`.)
3. In Foundry: **Manage Modules → enable "Foundry MCP Bridge"** in your world.
4. Open **Module Settings** and set **Relay URL** + **Relay token**.
5. Start the MCP server with matching `RELAY_URL` / `RELAY_TOKEN` (it hosts the
   relay and binds the URL's host/port).
6. Reload the world **as the GM**. You should see a "Foundry module connected"
   log on the server and a connect notification in Foundry. The AI's tools now
   act on this live world.

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

## 5. How the relay works

- The MCP server hosts the relay (`RelayServer`) and binds the host/port from
  `relayUrl`. The Foundry module connects out to it on world `ready`, presenting
  its token as `?token=…`; the server rejects mismatched tokens.
- Requests and responses are correlated by envelope `id`; a missing/slow module
  yields a structured `TIMEOUT`.
- For The Forge (HTTPS), terminate TLS in front of the relay (`wss://`) or use a
  relay on the GM's own machine (`ws://localhost`).

An alternative external-hub deployment is also available
(`WebSocketRelayTransport`, a relay *client*) if you prefer a standalone broker.

Everything — protocol, executor, reliability pipeline, settings, tools, the
relay server and the module bundle — is in place and tested (incl. a real
WebSocket end-to-end test) against the mock.
