# Local test quickstart (Claude Code + your local Foundry)

Everything that can be pre-filled **is** pre-filled in this branch. You only do
two things: (1) point Foundry at the relay, (2) paste one prompt.

Pre-filled values (in [`.mcp.json`](../.mcp.json)):

| | Value |
|---|---|
| Relay URL | `ws://localhost:8787` |
| Relay token | `local-dev-token` |

> These match what you'll enter in Foundry below. They are local-only dev values;
> change both sides if you ever expose the relay beyond `localhost`.

---

## A. One-time machine prep (~1 min)

```bash
git checkout claude/foundry-mcp-mock-build-9wum69
npm install
npm run bundle:module      # builds the server (dist) AND the Foundry module bundle
npm run selftest           # OPTIONAL: proves server -> relay -> module -> read-back works here
```

Opening the repo in **Claude Code** also runs these automatically via the
SessionStart hook, so the MCP server is built and ready before your first prompt.

---

## B. Install the module in your local Foundry (one manual step)

Foundry settings live inside the world DB, so they can't be committed — this is
the only thing you set by hand.

1. Make Foundry see the module (symlink the package folder into your data dir):

   ```bash
   # macOS/Linux — adjust the FoundryVTT data path to yours
   ln -s "$(pwd)/packages/foundry-module" \
     "$HOME/Library/Application Support/FoundryVTT/Data/modules/foundry-mcp-bridge"
   ```

   (Windows: copy `packages/foundry-module` into
   `...\FoundryVTT\Data\modules\foundry-mcp-bridge`.) The folder must contain
   `module.json` and `dist/index.js`.

2. Create a **test world** (any system) and launch it **as the GM**.
3. **Game Settings → Manage Modules → enable "Foundry MCP Bridge"** → save.
4. **Game Settings → Configure Settings → Module Settings → Foundry MCP Bridge**:
   - **Relay URL** = `ws://localhost:8787`
   - **Relay token** = `local-dev-token`
5. Reload the world (still as GM). Keep this browser tab open.

> The module connects only for a GM and only while the world tab is open.

---

## C. Run the session

1. In the repo, start **Claude Code**. The `foundry` MCP server is registered by
   [`.mcp.json`](../.mcp.json) and its tools are **pre-approved** (no
   confirmation prompts) via [`.claude/settings.json`](../.claude/settings.json).
   If Claude Code asks once to trust the project MCP server, accept it.
2. Paste this prompt:

```
Du er forbundet til min lokale Foundry-testverden via "foundry" MCP-serveren
(create_document, create_scene, update_document). Kør automatisk uden at spørge:

1. Opret en Actor ved navn "Probe" (type npc).
2. Opret en scene "MCP Test Scene" 1000x1000, grid 100.
3. Opdater Actor "Probe" til navnet "Probe v2".

For hvert trin: rapportér tool-resultatet (inkl. det oprettede id og
pipeline-steps). Hvis et trin fejler, så STOP og vis den strukturerede fejl i
stedet for at gætte. Til sidst: bekræft at de tre objekter findes i verdenen.
```

3. Watch the objects appear in your open Foundry tab. Because every write is
   read-back verified, a tool reports success only after confirming the change.

If a call returns `TIMEOUT`, the module isn't connected: check it's enabled, you
loaded the world as GM, the tab is open, and the URL/token match exactly.

---

## What I (the assistant) can and can't do

I run in an isolated cloud container with **no access to your computer or your
Foundry**, so I can't drive your machine or click in your browser. What I did
instead: pre-filled all config, made the tools run automatically, and proved the
full real-WebSocket path here with `npm run selftest` (passing). The live
verification against your actual world happens in **your** local Claude Code
session — that session's assistant uses the same tools to create and read back
the objects, exactly as scripted in the prompt above.
