# Foundry MCP Bridge — Project Plan

## Monorepo structure

npm **workspaces** monorepo, TypeScript (NodeNext ESM), tested with **vitest**.

```
foundry-mcp-bridge/
├── package.json                 # workspaces root, scripts (typecheck/test)
├── tsconfig.base.json           # shared compiler options
├── tsconfig.json                # solution file (project references)
├── vitest.config.ts
├── .github/workflows/ci.yml     # npm ci → typecheck → test
├── .env.example                 # template for mcp-server config
├── dev.config.example.json      # optional dev-only overrides
├── docs/
│   ├── foundry-live-api-plan.md
│   └── foundry-mcp-bridge-project-plan.md
├── packages/
│   ├── shared/                  # protocol + scene-builders (no I/O)
│   ├── foundry-module/          # runs inside Foundry; WS client; GM-only
│   └── mcp-server/              # MCP server; config; reliability pipeline
└── test/
    └── integration/
        └── mock-foundry.ts      # in-memory Foundry for tests
```

Each package has its own `package.json` and `tsconfig.json` (extending
`tsconfig.base.json`, `composite: true`). `packages/shared` is depended on by the
other two via the workspace name `@foundry-mcp-bridge/shared`.

## Config rules (hard requirements)

1. **No hardcoded connection strings** in committed code — ever.
2. The MCP server reads config in **exactly one place** (`mcp-server` config
   module). Everything else receives a typed config object.
3. Sources, in precedence order:
   - `.env` (always),
   - `dev.config.json` **only** when `NODE_ENV=development`.
4. The Foundry module gets its config from `game.settings` (relay URL + token),
   never from files in the repo.
5. **Missing required config fails loudly** with a clear message naming the key.
6. `.env.example` and `dev.config.example.json` are kept in sync with the schema.

## Mock-first test strategy

- All logic is tested against `test/integration/mock-foundry.ts`, an in-memory
  implementation of the Command protocol that mirrors Foundry's key conventions
  (`!actors!{id}`, embedded collections, etc.) and a `FilePicker` mock with both
  `data` and `forgevtt` sources.
- The mock supports **injectable failures** (reject / timeout / corrupt
  read-back) so the reliability pipeline (live-api-plan §11) is deterministically
  testable.
- CI never starts a real Foundry. The module's command-execution logic is unit
  tested against the mock document API.

## Build order (slices)

Mock-first, smallest useful increments, CI green after each:

0. ✅ Monorepo scaffold + `packages/shared` (protocol + scene-builders) + tests.
1. `test/integration/mock-foundry.ts` + tests.
2. `packages/foundry-module` skeleton (module.json v13..v14, WS client,
   GM-only guard, settings) tested against the mock.
3. `packages/mcp-server`: `create_document` (full pipeline) → `create_scene`
   → `update_document`.

## Conventions

- Commit small and often; keep `npm run typecheck` and `npm test` green.
- No real secrets in the repo; only `*.example` templates.
- Quests via Forien's Quest Log API (live-api-plan §7.1).
- Forge uploads via `FilePicker.upload("forgevtt", …)` (live-api-plan §4 A4).
