---
name: add-foundry-command
description: Add a new MCP tool / protocol command (or document type) to the foundry-mcp-bridge end-to-end. Use when the user wants a new capability exposed to the AI (e.g. "add a roll_table tool", "support deleting X", "add a new document type") — it walks the lockstep across shared protocol, executor, runtime, mock, test doubles, reliability pipeline, tools, and server registration so typecheck and tests stay green.
---

# Add a Foundry command/tool end-to-end

A command is a discriminated-union member keyed by `action`, exposed as an MCP
tool. Adding one touches **every layer** — and the type-only layers (executor
interface, test doubles) break `tsc` even though `npm test` (esbuild) still
passes. Follow the order below and finish with `npm run typecheck`, not just
`npm test`.

Full reference: `docs/command-lifecycle.md`. Read it if anything below is unclear.

## Before starting

- Confirm the tool's name, inputs, document/quest type, and whether it mutates
  (mutating tools run the reliability pipeline; reads don't).
- Decide which reliability category it fits: create / update / delete / embedded
  / quest / read (see the contract table in `docs/command-lifecycle.md`).

## The lockstep (edit in this order)

1. **`packages/shared/src/protocol.ts`** — add the zod `XCommand` schema; add it
   to the `Command` discriminated union; export the inferred type. Reuse
   `DocumentType` + `COLLECTIONS` for document-addressed commands.
2. **`packages/foundry-module/src/protocol-executor.ts`** — add the method to the
   `FoundryDocumentApi` interface **and** a `case "x":` in `dispatch()`.
3. **`packages/foundry-module/src/foundry-runtime.ts`** — implement against real
   Foundry globals. Honour `opts.dryRun` (validate without persisting). Throw
   `CommandExecutionError(code, message, details)` for structured failures.
4. **`test/integration/mock-foundry.ts`** — implement the in-memory behaviour
   (Foundry key conventions, honour `dryRun`).
5. **Update BOTH `FoundryDocumentApi` test doubles** (these are what step 2
   breaks):
   - `test/integration/mock-foundry-api.ts`
   - `packages/foundry-module/src/relay-client.test.ts` → `stubApi()`
6. **`packages/mcp-server/src/reliability.ts`** — add `xReliable()` using the
   pipeline for its category. Prefer the shared `runMutation` skeleton for
   create/update-shaped ops.
7. **`packages/mcp-server/src/tools.ts`** — add `XShape` (zod input) + `runX()`.
8. **`packages/mcp-server/src/server.ts`** — `registerTool("x", { description,
   inputSchema: XShape }, async (args) => toCallResult(await runX(transport, args, opts)))`.
9. **Tests** — cover the tool→pipeline path in
   `test/integration/mcp-tools.test.ts` and/or the executor→api path in
   `test/integration/module-executor.test.ts`. Test at least: happy path,
   dry-run, a NOT_FOUND/validation error, and (for mutations) a read-back
   mismatch + rollback where applicable.
10. **`.claude/settings.json`** — if it should be auto-allowed, add
    `mcp__foundry__x` to `permissions.allow`.

### Adding a document type instead

Extend the `DocumentType` enum **and** the `COLLECTIONS` map together in
`shared/protocol.ts` (they must stay in sync), then make sure
`foundry-runtime.ts` can resolve its document class / `game.<collection>`.

## Finish: verify

Run the full gate (see the `verify-bridge` skill):

```bash
npm run typecheck   # MUST pass — catches the interface/test-double drift npm test hides
npm test
npm run selftest    # if you touched the live server→relay→module path
```

If `tsc` complains that an object is "missing properties createX/updateX/…" from
`FoundryDocumentApi`, you skipped step 5 — update the test doubles.
