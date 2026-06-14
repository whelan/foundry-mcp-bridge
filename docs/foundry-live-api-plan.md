# Foundry Live API — Plan

> Status: living design document. This captures the architecture for letting an
> AI create/update/delete documents in a **running** Foundry VTT world (V14),
> both locally and on The Forge.

## 1. Goal

Expose a small, safe, well-typed surface so an AI agent (via MCP) can manipulate
live Foundry documents — actors, scenes, journals, roll tables and quests —
without direct database access and without a restart. Everything must be
developable and testable **without a real Foundry** (mock-first).

## 2. Why "live"?

Editing the world database on disk requires Foundry to be stopped and risks
corruption. A running world already has the full document API (`Actor.create`,
`document.update`, embedded-document CRUD, `FilePicker.upload`, module APIs like
Forien's Quest Log). We drive *that* API instead.

## 3. Components

```
AI (MCP client)
   │  MCP (stdio/JSON-RPC)
   ▼
mcp-server (Node)  ── reliability pipeline ──┐
   │  Command protocol (WebSocket relay)      │
   ▼                                          │
foundry-module (runs inside Foundry, GM tab)  │
   │  Foundry document API / module APIs       │
   ▼                                          │
Running Foundry world  ◄──── read-back verify ┘
```

- **packages/shared** — the wire contract: zod `Command` / `CommandEnvelope` /
  `CommandResult` and the V14 `scene-builders`. Shared by both ends so the
  protocol can never drift.
- **packages/mcp-server** — the MCP server the AI talks to. Owns config, the
  relay client, and the reliability pipeline (§11).
- **packages/foundry-module** — a Foundry module that opens a WebSocket to the
  relay, receives `Command`s and executes them against the live document API.
  GM-only.

## 4. Connection approaches

We considered three transports for getting a `Command` from the MCP server into
a running Foundry world:

- **A — module relay (CHOSEN).** A tiny relay; the Foundry module connects out
  over WebSocket and executes commands. Works identically local and on The
  Forge because the module runs *inside* the browser/world; no inbound port to
  Foundry needed.
- B — Foundry REST/socket API directly. Rejected: not exposed for arbitrary
  document writes; brittle across hosts.
- C — on-disk database edits. Rejected: requires world offline; corruption risk.

### A4 — The Forge asset upload

On The Forge, asset uploads must go through the Forge bucket, not the local
data dir. The module performs uploads via
`FilePicker.upload("forgevtt", target, file, options)`. Locally the source is
`"data"`. The active source is detected at runtime; the mock exposes both a
`"data"` and a `"forgevtt"` source so the upload path is testable.

## 5. Security

- The module guards every command with a **GM-only** check (`game.user.isGM`).
- The relay URL and an auth token are configured in Foundry **module settings**
  (never hardcoded). The MCP server holds the matching token in `.env`.
- Mismatched/absent token ⇒ command rejected with a structured error.

## 6. The Command protocol (summary)

See `packages/shared/src/protocol.ts` for the authoritative zod schemas.

- `CommandEnvelope` = `{ id, command, dryRun?, token?, protocolVersion }`.
- `Command` is a discriminated union on `action`:
  `create` | `update` | `delete` | `createEmbedded` | `updateEmbedded` |
  `deleteEmbedded` | `find`.
- `CommandResult` = `{ id, ok: true, data }` | `{ id, ok: false, error }`.

Foundry key conventions are honoured by the document layer / mock: top-level
documents are addressed by `id`, and Foundry-internal keys take the form
`!actors!{id}`, `!scenes!{id}`, embedded as `!scenes.tokens!{sceneId}.{tokenId}`.

## 7. Tools (MCP surface)

Tools are added incrementally; each ships with the full reliability pipeline.

1. `create_document` — **first tool.** Generic typed create for any supported
   document type. Validate → dry-run → write → read-back verify.
2. `create_scene` — convenience wrapper that builds a V14 scene payload via the
   shared `scene-builders`, then routes through `create_document`.
3. `update_document` — partial update by `{ documentType, id, data }` with
   read-back verification of the changed fields.
4. `delete_document` — delete by `{ documentType, id }`.
5. embedded CRUD (`create_embedded` / `update_embedded` / `delete_embedded`).
6. `find_documents` — query/read for verification and for the AI to inspect.
7. `create_quest` — see §7.1.

### 7.1 Forien's Quest Log

Quests are **not** created as raw `JournalEntry` documents. When the
`forien-quest-log` module is active we create quests through its public API
(`Quests.create(...)` / the module's exposed quest API). The mock models this as
a dedicated quest store so the contract is testable; a raw-journal fallback is
explicitly out of scope to avoid producing quests the module cannot manage.

### 7.2 update / modify semantics

- Updates are **partial merges** (Foundry `document.update(diff)` semantics).
- Nested keys use Foundry dot-notation (`"system.attributes.hp.value"`).
- Embedded collections are modified via embedded CRUD, never by replacing the
  whole parent.
- Every write is followed by a read-back of the affected paths (§11).

## 8. Configuration

- MCP server: `.env` is the single read site (see project plan §config). Optional
  `dev.config.json` only when `NODE_ENV=development`.
- Foundry module: relay URL + token via `game.settings`.
- Missing required config fails loudly at startup.

## 9. Versioning

`module.json` declares compatibility `minimum: 13`, `verified: 14`. The protocol
carries a `protocolVersion`; mismatches produce a structured error rather than a
silent failure.

## 10. Testing strategy

Mock-first. An in-memory `mock-foundry` speaks the Command protocol with
Foundry's key conventions and injectable failures (reject/timeout) so the
reliability layer can be exercised deterministically. No real Foundry in CI.

## 11. Reliability

Every mutating tool runs the same pipeline:

1. **Validate** the input against the zod schema (reject early, structured).
2. **Dry-run** — ask the module to validate the construction without persisting
   (or simulate locally) so obviously bad payloads never hit the world.
3. **Write** — execute the command.
4. **Read-back verify** — re-read the document and confirm the intended fields
   match. Mismatch ⇒ structured error.
5. **Structured error / rollback** — on failure return a typed error
   (`code`, `message`, `details`); for multi-step operations, best-effort
   rollback of what was created.

Transport concerns: timeouts, bounded retries with backoff for idempotent
reads, and correlation by envelope `id`.
