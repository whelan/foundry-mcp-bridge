# Setup & configuration — local Foundry and The Forge

A step-by-step runbook for activating the bridge against a real world, plus a
reference for every configurable property.

## The moving parts

```
Your AI client (Claude Desktop / Claude Code)
   │ spawns over stdio
   ▼
MCP server (this repo)  ──hosts──▶  relay (WebSocket) at RELAY_URL
   ▲                                      ▲
   │ MCP tools                            │ Foundry module connects OUT
   │                                      │ (runs in the GM's browser)
   └──────────────── you ────────────────┘   local Foundry or The Forge
```

Two sides must agree on **URL + token**: the MCP server (`.env`) and the Foundry
module (Module Settings). The MCP server hosts the relay; the module connects to
it. The server is launched by your AI client (it talks MCP over stdio and opens
the relay as a side effect while running).

---

## 0. What you need ready

A quick checklist before you start:

- [ ] **Node.js ≥ 20** and this repo cloned, with `npm install` run once.
- [ ] An **AI client that speaks MCP** — e.g. Claude Desktop or Claude Code —
      that you can add a custom server to.
- [ ] A **Foundry world you are GM in**, on **v13 or v14** (local install or a
      Forge game).
- [ ] A **shared secret token** you invent (any random string, e.g. from
      `openssl rand -hex 16`). Used on both sides.
- [ ] A **relay URL** you choose:
  - Local: `ws://localhost:8787` (or any free port) — works as-is.
  - The Forge (HTTPS world): a **`wss://`** URL terminated by a TLS proxy in
      front of the relay, **or** `ws://localhost:8787` if you run the MCP server
      on the same machine as the GM's browser.
- [ ] For a remote relay only: a host/port reachable from the GM's browser and
      TLS (see §6).

That's all — there is no database, no extra service, and nothing to pre-create
inside Foundry. The module registers its own settings on load.

---

## 1. Build

```bash
npm install            # once
npm run build          # compiles the MCP server (-> packages/mcp-server/dist)
npm run bundle:module  # builds the browser bundle (-> packages/foundry-module/dist/index.js)
```

`npm test` and `npm run typecheck` should be green. No real Foundry is needed for
development.

---

## 2. Choose the shared secret

Pick one token and use the **same value** in step 3 (`RELAY_TOKEN`) and step 5/6
(module **Relay token**). Example:

```bash
openssl rand -hex 16    # -> e.g. 9f2c…  (copy this)
```

A token is optional for a pure `ws://localhost` setup but recommended always.

---

## 3. Connect the MCP server to your AI client

The MCP server is **launched by your AI client**, which passes the config via
environment variables. You do **not** normally run it by hand.

**Claude Desktop** — edit the config file
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows) and add:

```json
{
  "mcpServers": {
    "foundry": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/foundry-mcp-bridge/packages/mcp-server/dist/index.js"],
      "env": {
        "RELAY_URL": "ws://localhost:8787",
        "RELAY_TOKEN": "PASTE-YOUR-TOKEN"
      }
    }
  }
}
```

Restart Claude Desktop. It will spawn the server (which opens the relay on
`localhost:8787`).

**Claude Code** — equivalent one-liner:

```bash
claude mcp add foundry \
  -e RELAY_URL=ws://localhost:8787 \
  -e RELAY_TOKEN=PASTE-YOUR-TOKEN \
  -- node /ABSOLUTE/PATH/TO/foundry-mcp-bridge/packages/mcp-server/dist/index.js
```

> Manual run (for debugging only): `RELAY_URL=ws://localhost:8787
> RELAY_TOKEN=… node packages/mcp-server/dist/index.js`. It will wait on stdio;
> missing `RELAY_URL` fails loudly.

---

## 4. Install the module in a local Foundry

1. Make Foundry see the module: copy or symlink the `packages/foundry-module`
   folder (it must contain `module.json` **and** `dist/index.js` from step 1)
   into your Foundry data dir at `Data/modules/foundry-mcp-bridge`. (Or install
   via a manifest URL pointing at `module.json`.)
2. In Foundry: **Manage Modules → enable "Foundry MCP Bridge"** in your world.
3. **Game Settings → Configure Settings → Module Settings → Foundry MCP Bridge**:
   set **Relay URL** = `ws://localhost:8787` and **Relay token** = your token.
4. Reload the world **as the GM**.

---

## 5. The Forge specifics

The module runs in the **GM's browser**, so it connects *outbound* — no inbound
port to your Foundry is needed.

1. Install the module on your Forge game: **Forge → Game Configuration →
   Modules → Install/Upload** (upload the bundled module folder, or install from
   a manifest URL).
2. Enable it and set **Relay URL** + **Relay token** as in step 4.
3. **Mixed content:** a Forge world is HTTPS, so a remote insecure `ws://` is
   blocked by the browser — use **`wss://`** (TLS proxy in front of the relay).
   Browsers treat `ws://localhost` as secure, so a relay on the GM's own machine
   works even from the HTTPS Forge tab.
4. **Asset uploads** are automatic: on The Forge the module uploads via
   `FilePicker.upload("forgevtt", …)`; locally it uses `"data"`. No config.

---

## 6. Verify it's connected

- On the **server** side you'll see `info: Foundry module connected` (logged to
  stderr) once the GM loads the world.
- From your **AI client**, the tools `create_document`, `create_scene` and
  `update_document` are available. Try: *"create a test Actor named Probe"* —
  it should appear in the world, and (because of the read-back step) the tool
  reports success only after confirming it.

If a call returns `TIMEOUT`, the module isn't connected (not loaded, not GM,
wrong URL/token, or the world tab is closed).

---

## Property reference

### MCP server (env / `.env`, copy from [`.env.example`](../.env.example))

| Property | Env var | Required | Default | What it is |
| --- | --- | --- | --- | --- |
| `relayUrl` | `RELAY_URL` | ✅ | — | WebSocket address the server **binds** the relay to and the module connects to (`ws://host:port` or `wss://…`). Host/port/path are parsed from it. Must match the module's **Relay URL**. |
| `relayToken` | `RELAY_TOKEN` | optional* | — | Shared secret. When set, the module must present it (`?token=…`) and every command carries it; mismatches are rejected (`AUTH`). *Use one for anything beyond localhost. |
| `requestTimeoutMs` | `RELAY_TIMEOUT_MS` | optional | `10000` | Per-command transport timeout (ms). A slow/unreachable module yields a `TIMEOUT` error. |

In development only, the same keys may come from `dev.config.json` (`relayUrl`,
`relayToken`, `requestTimeoutMs`); see
[`dev.config.example.json`](../dev.config.example.json). Environment values win.

### Foundry module (Module Settings, world scope, GM only)

| Setting | Internal key | What it is |
| --- | --- | --- |
| **Relay URL** | `relayUrl` | Must equal the server's `relayUrl`. The module connects out to it on world `ready`. |
| **Relay token** | `relayToken` | Must equal the server's `relayToken`. Empty only for a trusted `ws://localhost` relay. |

The module **only** connects when the current user is a **GM**; non-GM clients
never open the relay.

---

## How the relay works

- The MCP server hosts the relay (`RelayServer`) and binds host/port from
  `relayUrl`. The module connects out, presenting its token as `?token=…`; the
  server rejects mismatched tokens.
- Requests/responses are correlated by envelope `id`; a missing/slow module
  yields a structured `TIMEOUT`.
- An alternative external-hub deployment exists (`WebSocketRelayTransport`, a
  relay *client*) if you prefer a standalone broker.

Everything — protocol, executor, reliability pipeline, settings, tools, the
relay server and the module bundle — is in place and tested (incl. a real
WebSocket end-to-end test) against the mock.
