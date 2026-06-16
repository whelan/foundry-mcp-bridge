# Local test quickstart (Claude Code + your local Foundry)

Everything that can be pre-filled **is** pre-filled in this branch. For a local
machine you don't type any settings at all — the module defaults to the local
relay. You only (1) install + enable the module, (2) paste one prompt.

Pre-filled values:

| | Value | Where |
|---|---|---|
| Relay URL | `ws://localhost:8787` | [`.mcp.json`](../.mcp.json) (server) **and** the module's built-in default |
| Relay token | _none_ (localhost) | optional; set one on both sides only for non-local relays |

> The localhost default needs no token. For anything beyond your own machine,
> set a real `wss://` URL + token in both `.mcp.json` (or `.env`) and Module
> Settings.

---

## Can my local Claude do all of this?

Yes. Your **local** Claude Code session has shell access to your machine, so you
can simply ask it to:

```
Byg projektet og installér Foundry-modulet i min lokale Foundry:
kør `npm install`, `npm run install:foundry`, og `npm run selftest`.
Find selv min Foundry data-sti (eller spørg mig). Rapportér resultatet.
```

It will build, symlink the module into `…/FoundryVTT/Data/modules/`, and run the
self-test. The only thing it can't do from outside Foundry is click "enable
module" / load the world — see step B (or ask about the DB option below).

---

## A. Build + install (your local Claude, or you)

```bash
npm install
npm run install:foundry   # builds the module bundle AND symlinks it into Foundry's modules dir
npm run selftest          # OPTIONAL: proves server -> relay -> module -> read-back on this machine
```

`install:foundry` autodetects the common Foundry data dir; pass it explicitly if
needed: `node scripts/install-into-foundry.mjs /path/to/FoundryVTT/Data`.

Opening the repo in **Claude Code** also builds everything via the SessionStart
hook, so the MCP server is ready before your first prompt.

---

## B. Enable it in your test world (one or two clicks)

1. Create a **test world** (any system) and launch it **as the GM**.
2. **Game Settings → Manage Modules → enable "Foundry MCP Bridge"** → save &
   reload.
3. That's it for local: the module connects to `ws://localhost:8787`
   automatically (built-in default, no token). Keep the world tab open.

> Want to set a custom relay/token? **Game Settings → Configure Settings →
> Module Settings → Foundry MCP Bridge**.
>
> Want *zero* clicks in Foundry? Your local Claude can also write the world's
> settings + module-activation directly into the world's LevelDB — but only
> while **Foundry is closed** (the DB is locked while running), and the encoding
> is version-specific. Ask for the DB-write script if you want that.

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
