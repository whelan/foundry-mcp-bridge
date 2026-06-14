# foundry-mcp-bridge

Live AI→Foundry VTT integration: an MCP server + a Foundry V14 module that let an AI assistant
create, update and delete documents (actors, scenes, journals, roll tables, …) and quests
(via Forien's Quest Log) in a **running** Foundry world — locally and on **The Forge**.

> Status: early scaffold. See `docs/` in the companion planning repo for the full design
> (`foundry-live-api-plan.md`, `foundry-mcp-bridge-project-plan.md`).

## Packages

| Package | What |
|---------|------|
| `packages/shared` | Protocol schemas (zod) + Foundry V14 document builders, shared by server and module |
| `packages/mcp-server` *(wip)* | MCP server Claude talks to; exposes `create_document`, `create_scene`, `create_quest`, `update_*`, `find_*` |
| `packages/foundry-module` *(wip)* | Foundry V14 module that runs in the GM client and executes commands via the document API |

## Develop

```bash
npm install
npm run typecheck
npm test
```

## Configuration (no hardcoded connection strings)

All configuration is supplied by the operator — nothing host-specific lives in committed code.

| What | Where | Committed? |
|------|-------|-----------|
| Relay URL, shared token | Foundry module settings (in-world UI) **and** server `.env` | No (`.env.example` yes) |
| Server env (port, token, optional Forge API key) | `.env` (read only in `mcp-server` config) | No |
| Dev-only overrides | `dev.config.json` (loaded only when `NODE_ENV=development`) | No (`dev.config.example.json` yes) |

Copy the examples and fill them in:

```bash
cp .env.example .env
cp dev.config.example.json dev.config.json   # optional, dev only
```

See `.env.example` for every variable and what to put where. There are **no** default URLs that
point at a private machine — a missing required value fails fast with a clear message.
