---
name: verify-bridge
description: Run the full verification gate for foundry-mcp-bridge in the correct order (build → typecheck → test → selftest). Use after any code change to confirm it's actually done, before committing/pushing, or when asked to "verify", "check it works", or "make sure CI passes". Crucially runs typecheck because npm test alone (esbuild) does NOT type-check and hides tsc errors.
---

# Verify the bridge

`npm test` runs under vitest/esbuild, which performs **no type checking** — tests
can be green while `tsc` is broken (this exact gap has shipped breakage before).
So verification is not "run the tests"; it is the gate below, in order.

## The gate

```bash
npm run typecheck   # tsc --build AND tsc -p tsconfig.test.json (type-checks tests too)
npm test            # vitest run
```

Run **`npm run selftest`** as well whenever the change touches the live path
(mcp-server transport/relay-server/relay-client/server/tools, or the wire
protocol). It builds and exercises the real MCP server → WebSocket relay →
module → read-back path against an in-memory stub — proving the wiring, not just
the unit logic:

```bash
npm run selftest
```

For a change to the browser-loadable module, also confirm it bundles:

```bash
npm run bundle:module   # esbuild → packages/foundry-module/dist/index.js
```

## Interpreting failures

- **`tsc` "missing properties createQuest/…" from `FoundryDocumentApi`** — a
  method was added to the executor interface but a test double wasn't updated.
  Fix `test/integration/mock-foundry-api.ts` and the `stubApi()` in
  `packages/foundry-module/src/relay-client.test.ts`.
- **Tests green but typecheck red** — expected; trust typecheck. Don't declare
  done on a green `npm test` alone.
- **selftest hangs/times out** — check the relay transport / `PendingRequests`
  correlation and that the stub answers the envelope id.

## Done means

`typecheck` + `test` both pass (and `selftest` if the live path changed). Only
then report the change as complete; cite the actual results.
