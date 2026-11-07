# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server plus a Foundry VTT (v13–v14) module that let an AI create/update/delete
documents (actors, scenes, journals, roll tables, items, macros, playlists, and Forien's
Quest Log quests) in a **running** Foundry world — locally and on The Forge. The two ends
talk over a WebSocket relay using a shared, versioned wire protocol.

## Commands

```bash
npm install
npm run build         # tsc --build across the package project references
npm run typecheck     # tsc --build AND tsc -p tsconfig.test.json (type-checks the tests)
npm test              # vitest run
npm run test:watch    # vitest (watch)
npm run bundle:module # build + esbuild the Foundry module -> packages/foundry-module/dist/index.js
npm run selftest      # build + run the real server->relay->module->read-back path end-to-end
npm run install:foundry  # bundle the module and install it into a local Foundry
npm run lint:statblock -- path/to/note.md  # check a statblock note against the 2024-only grammar
npm run bundle:write-statblock-skill  # regenerate .claude/skills/write-statblock/'s portable .cjs bundle
npm run tools:size    # per-tool chars of name+description+JSON schema (context cost); -- --groups core,scenes
npm run tools:stats   # summarize TOOL_STATS_FILE usage JSONL (per tool, never used, daily vs extra groups)
```

Run a single test file or test:

```bash
npx vitest run test/integration/mock-foundry.test.ts
npx vitest run -t "read-back mismatch"
```

**Important:** `npm test` uses vitest/esbuild, which does **no type checking**. Tests can
pass while `tsc` is broken. Always run `npm run typecheck` before considering work done —
CI type-checks both the source projects and `tsconfig.test.json` (the test files import
the module's `FoundryDocumentApi`, so adding a method to that interface breaks the test
doubles until they're updated). For a change that touches the live path, also run
`npm run selftest`. The **`verify-bridge`** skill encodes this gate.

## Skills

- **`add-foundry-command`** — adding a new MCP tool / protocol command (or document type)
  end-to-end. Walks the lockstep across all layers so typecheck and tests stay green.
- **`verify-bridge`** — the verification gate (build → typecheck → test → selftest) in the
  right order, including why `npm test` alone is insufficient.
- **`write-statblock`** — writing (or editing) an Obsidian Fantasy Statblocks note and
  linting it against the 2024-only action grammar (`npm run lint:statblock`) before import,
  since 2014-style text silently becomes a non-rollable feat with no error. The skill folder
  ships a bundled, dependency-free `lint-statblock.bundle.cjs` (regenerated via
  `npm run bundle:write-statblock-skill`) so it can be copied wholesale into another repo
  (e.g. an Obsidian vault repo) and run with bare `node`, no monorepo required.

## Architecture

Three workspace packages under `packages/*` plus `test/integration`. Data flows:

```
MCP client → mcp-server (tools → reliability pipeline → RelayTransport)
           → WebSocket relay → foundry-module (RelayClient → protocol-executor → FoundryDocumentApi)
           → real Foundry world (or mock-foundry in tests)
```

- **`packages/shared`** — the single source of truth for the wire contract. `protocol.ts`
  holds zod schemas (`Command`, `CommandEnvelope`, `CommandResult`), `PROTOCOL_VERSION`,
  the `DocumentType` enum + `COLLECTIONS` map, and `checkEnvelopeGuards` (protocol-version
  / token / GM checks). `objects.ts` mirrors Foundry's `expandObject` / `getByPath` /
  `applyUpdate` dot-notation semantics. `scene-builders.ts` builds V14 scene data.
  Both ends import from here so the protocol can never drift.

- **`packages/foundry-module`** — the Foundry-side module. `protocol-executor.ts` is the
  **testable core**: it guards and dispatches a `CommandEnvelope` against the narrow
  `FoundryDocumentApi` interface and knows nothing about WebSockets or Foundry globals.
  `foundry-runtime.ts` is the real `FoundryDocumentApi` (calls `Actor.create`,
  `document.update`, embedded CRUD, Forien's Quest Log) and is **not run in CI**.
  `relay-client.ts` is the WebSocket client; `index.ts` wires it all to Foundry hooks
  (GM-only, opens the relay on `ready`).

- **`packages/mcp-server`** — the MCP server. `tools.ts` defines each tool's input shape
  and `run*` handler; `server.ts` is a thin MCP-SDK adapter registering them. `reliability.ts`
  is the backbone every mutating tool runs through: **dry-run → write → read-back verify →
  structured error / rollback** (see the shared `runMutation` skeleton — callers supply only
  the mutate command, expected read-back subset, id source, and rollback). `relay-transport.ts`
  defines the `RelayTransport` interface, `PendingRequests` (id-correlation + per-request
  timeout, shared by both transports), and the browser-side `WebSocketRelayTransport`;
  `relay-server.ts` is the Node relay hub (`RelayServer`), which also accepts
  `?role=peer` connections from other MCP processes and forwards their envelopes to the
  one module. `relay-peer.ts` has `PeerRelayTransport` and `AutoRelayTransport` (bind the
  port, else join as peer on EADDRINUSE, promote when the owner goes); `hub.ts`
  (`npm run relay:hub`) runs a standalone hub so every MCP process is a peer. `config.ts` is the one place
  config is read.

- **`test/integration`** — `mock-foundry.ts` is an in-memory Foundry implementing the
  Command protocol with Foundry's key conventions (`!actors!{id}`, embedded keys), a
  FilePicker mock (`data` + Forge `forgevtt` sources), a separate quest store, and
  injectable failures (throw / hang / error result). `mock-foundry-api.ts` adapts it to
  `FoundryDocumentApi`. Everything is developed and tested **mock-first — no real Foundry
  required.**

## Conventions to preserve

- **Mock-first.** The reliability pipeline depends only on `RelayTransport`, and the
  executor only on `FoundryDocumentApi`, precisely so both can be driven by the mock with
  injected timeouts and read-back mismatches. Keep new logic on the testable side of these
  seams; keep Foundry-global code (foundry-runtime.ts, index.ts) thin.

- **Protocol changes go in `packages/shared` first.** Adding a document type means updating
  the `DocumentType` enum and `COLLECTIONS` together. Adding a command means adding its zod
  schema to the `Command` discriminated union — then the executor dispatch, the
  `FoundryDocumentApi` interface, the real runtime, the mock, and every test double of that
  interface all need the new method.

- **Reliability is intentional, not overhead.** The extra read-back round-trip after a write
  is a correctness guarantee (verify + rollback on mismatch), not waste. Deletes are terminal
  and skip read-back; quests skip read-back because they aren't queryable via standard `find`.

- **Config.** The MCP server reads config in exactly one place (`config.ts`), precedence:
  `process.env` → `.env` → `dev.config.json` (only when `NODE_ENV=development`). Missing
  required config fails loudly naming the key.

- **Tool groups + stats.** Every tool is tagged in `tool-groups.ts` (`TOOL_CATALOG`); a new
  tool must be added there (its name type-checks `register`). `FOUNDRY_TOOLS` picks groups
  (default `all`). `server.ts`'s `add()` is the single handler wrapper (trace, change log,
  usage stats to `TOOL_STATS_FILE`). Keep descriptions terse — check `npm run tools:size`. No connection strings are hardcoded; the
  Foundry module gets its relay URL + token from Module Settings.

## Design docs

`docs/command-lifecycle.md` is the contributor spec — the exact path a command takes, the
**lockstep checklist** for adding one, the per-category reliability-pipeline contract, and
the error taxonomy. Read it before adding or changing a command. `docs/foundry-live-api-plan.md`
is the design spec — tools (§7), Forien's Quest Log (§7.1), update semantics (§7.2),
reliability (§11). `docs/foundry-mcp-bridge-project-plan.md` covers the monorepo layout,
config rules, and mock-first strategy.
