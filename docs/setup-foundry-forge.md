# Setup & configuration — local Foundry and The Forge

A step-by-step runbook for activating the bridge against a real world, plus a
reference for every configurable property.

## Two separate components (read this first)

There are **two distinct pieces of software**, running in **two different
places**. The MCP server is **not** inside the Foundry module.

| Component | What it is | Where it runs | Who starts it | You... |
|---|---|---|---|---|
| **MCP server** (`packages/mcp-server`) | Node program that exposes the tools to the AI and **hosts the relay** | On **your computer**, as a normal process | Your **AI client** (Claude Desktop / Claude Code) | register it in the AI client |
| **Foundry module** (`packages/foundry-module`) | JavaScript that calls Foundry's document API | Inside **Foundry / the GM's browser** | **Foundry**, when you load the world | install it in Foundry |

They are separate on purpose: the AI can only talk to a **local process over
stdio** (that's the MCP server), while Foundry's API (`Actor.create`, …) only
exists **inside the running Foundry** (that's the module). They cannot talk
directly, so a **relay WebSocket bridges them**.

```
Claude  ──stdio (MCP)──▶  MCP server (your computer) ──┐
                                                       │  relay (WebSocket, RELAY_URL)
Foundry module (in the GM's browser) ──────────────────┘
        │
        ▼
   your running world (Actor / Scene / ...)
```

So there are only **two things you touch**: install the module in Foundry, and
register the MCP server in your AI client. There is **no third/extra server** to
run — the "relay" is just a WebSocket the MCP server opens while it runs.

The two sides must agree on **URL + token**: the MCP server (config from your AI
client / `.env`) and the Foundry module (Module Settings).

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

1. Install the module on your Forge game with its **manifest URL**:
   **Forge → Game Configuration → Modules → Install Module**, paste
   `https://github.com/whelan/foundry-mcp-bridge/releases/latest/download/module.json`.
   Updates then come through Foundry's own **Check for Updates / Update** like any
   other module. `.github/workflows/module-release.yml` publishes a release
   (`module-v<version>`, with `module.json` and `module.zip`) on every module
   change to `main`; bump `version` in `module.json` for Foundry to offer it as an
   update. Relay URL and token live in the world's settings database, not in the
   module folder, so they survive.

   > The repo must be **public** for this: Forge's servers cannot read a private
   > repo's releases. An install made earlier by zip upload has no manifest URL —
   > uninstall it once and reinstall from the manifest URL to get updates. The zip
   > on the release page still works for a hand upload.
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

| `codexBin` | `CODEX_BIN` | optional | `codex` | The OpenAI Codex CLI used by `generate_image`. Set an absolute path (macOS Homebrew: `/opt/homebrew/bin/codex`) when your MCP client starts the server with a minimal `PATH`. Run `codex login` once. |
| `imageOutputDir` | `IMAGE_GEN_OUTPUT_DIR` | optional | state dir `/generated-images` | Where generated images are written before upload. |
| `imageCodexModel` | `IMAGE_GEN_CODEX_MODEL` | optional | Codex default | Model passed to `codex exec -m`. |
| `imageTimeoutMs` | `IMAGE_GEN_TIMEOUT_MS` | optional | `300000` | Per-image timeout. |
| `changeLog` | `CHANGE_LOG` | optional | on | `0`/`false` turns the change log (and `list_changes` / `undo_change`) off. |
| `changeLogDir` | `CHANGE_LOG_DIR` | optional | macOS `~/Library/Application Support/foundry-mcp-bridge`, else `$XDG_STATE_HOME` or `~/.local/state/foundry-mcp-bridge` | Directory of `changes.jsonl`, the append-only change log. |

In development only, the same keys may come from `dev.config.json` (`relayUrl`,
`relayToken`, `requestTimeoutMs`); see
[`dev.config.example.json`](../dev.config.example.json). Environment values win.

### Foundry module (Module Settings, world scope, GM only)

| Setting | Internal key | What it is |
| --- | --- | --- |
| **Relay URL** | `relayUrl` | Must equal the server's `relayUrl`. The module connects out to it on world `ready`. |
| **Relay token** | `relayToken` | Must equal the server's `relayToken`. Empty only for a trusted `ws://localhost` relay. |
| **Session position log URL** | `positionLogUrl` | Default `http://localhost:8789`. Once a minute the GM's browser POSTs where every connected player is (viewed scene, token, regions, nearest map pin, level, hidden) to this collector — the vault's `dnd-whisper/scripts/position-collector.mjs`, which `run-session.sh` starts and stops with the session recording. Independent of the relay and the MCP server. While nothing answers, rows are dropped (the browser console shows one refused request a minute); after a collector has answered, up to 15 unsent rows are kept and resent. Empty turns it off. Code: `packages/foundry-module/src/position-log.ts`. |

| **Bridge permission: actors / scenes / journals / tables / items / macros / playlists / folders** | `permission.<category>` | What the AI may do to that category: *Read only*, *Create and edit, never delete* (**default**), or *Full*. Enforced in the module on every command, dry-runs included; refused writes return `FORBIDDEN`. Read per command, so a change applies at once. The bridge cannot change it. Scene tools (`switch_scene`, `toggle_condition`) count as scene edits; quests as journals. **Deleting is off out of the box** — pick *Full* for a category when you want the AI to delete (and for `undo_change` to undo a create there). |

The module **only** connects when the current user is a **GM**; non-GM clients
never open the relay.

---

## Multiple MCP sessions (hub / peer mode)

Only one process can bind `RELAY_URL`'s port. The first MCP server process to
start owns the relay; any further process (a second Claude Code session, Codex,
...) gets `EADDRINUSE`, logs `relay mode peer` on stderr, and connects to the
owner as a **peer** (`?role=peer&token=...`). The owner forwards each peer's
envelopes to the single Foundry module connection and routes results back by
envelope id. If the owner exits, a peer re-binds the port (promotion) and the
module reconnects to it; otherwise peers keep reconnecting.

For a stable setup, run a standalone hub that owns the port and nothing else:

```bash
RELAY_URL=ws://localhost:8787 RELAY_TOKEN=... npm run relay:hub   # or the foundry-relay-hub bin
```

Every MCP process then starts in peer mode automatically. Peer requests that
arrive with no module connected fail with `TIMEOUT` after the hub's request
timeout; a module disconnect fails in-flight peer requests with `INTERNAL`.

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
