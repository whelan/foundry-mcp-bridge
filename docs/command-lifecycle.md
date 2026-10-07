# Command lifecycle & contributor spec

The precise reference for how a command flows through every layer, the exact
files to touch (in lockstep) when adding one, the reliability-pipeline contract,
and the error taxonomy. This complements the design docs
(`foundry-live-api-plan.md`, `foundry-mcp-bridge-project-plan.md`) with the
"what do I actually change" detail.

## The path a command takes

```
MCP client
  → mcp-server/server.ts        registerTool(name, shape, handler)
  → mcp-server/tools.ts         <Name>Shape (zod) + run<Name>()  ── tests call run* directly
  → mcp-server/reliability.ts   <op>Reliable(): dry-run → write → read-back → rollback
  → mcp-server/relay-transport  RelayTransport.request(envelope)  (PendingRequests: id + timeout)
  → relay-server.ts             RelayServer hub  ── WebSocket ──
  → foundry-module/relay-client.ts   receives envelope
  → foundry-module/protocol-executor.ts  checkEnvelopeGuards → dispatch(command)
  → FoundryDocumentApi          create/update/remove/embedded/find/quest
       ├─ foundry-runtime.ts    real Foundry globals (NOT run in CI)
       └─ test/mock-foundry-api → mock-foundry.ts  (tests + selftest)
```

Two seams make the whole thing testable without a real Foundry, and must stay clean:

- **`RelayTransport`** — the reliability pipeline depends only on this, so it is
  driven in tests by a mock-foundry-backed transport with injected timeouts and
  read-back mismatches.
- **`FoundryDocumentApi`** — the executor depends only on this; `foundry-runtime.ts`
  is the real impl, `mock-foundry-api.ts` the test impl.

## Adding a new command/tool — the lockstep

A command is a discriminated-union member keyed by `action`. Adding one means
touching every layer below. Skipping the type-only layers still **compiles
tests under esbuild** but **fails `tsc`** — so run `npm run typecheck`, never
just `npm test` (see "Verification").

Order to edit:

1. **`packages/shared/src/protocol.ts`** — add a zod `XCommand` schema and add it
   to the `Command` discriminated union. Reuse `DocumentType`/`COLLECTIONS` for
   document-addressed commands. Export the inferred type.
2. **`packages/foundry-module/src/protocol-executor.ts`** —
   - add the method to the **`FoundryDocumentApi`** interface, and
   - add a `case "x":` to `dispatch()` mapping the command to that method.
3. **`packages/foundry-module/src/foundry-runtime.ts`** — implement the method
   against real Foundry globals (respect `opts.dryRun`: construct/clone to
   validate, do not persist). Throw `CommandExecutionError(code, msg, details)`
   for structured failures.
4. **`test/integration/mock-foundry.ts`** — implement the behaviour in the
   in-memory store (Foundry key conventions; honour `dryRun`).
5. **Every `FoundryDocumentApi` test double** — these break the moment step 2
   changes the interface:
   - `test/integration/mock-foundry-api.ts` (the adapter), and
   - `packages/foundry-module/src/relay-client.test.ts` (`stubApi()`).
6. **`packages/mcp-server/src/reliability.ts`** — add `xReliable()` running the
   appropriate pipeline (see contract below).
7. **`packages/mcp-server/src/tools.ts`** — add `XShape` (zod input) + `runX()`.
8. **`packages/mcp-server/src/server.ts`** — `registerTool("x", {description,
   inputSchema: XShape}, …)`.
9. **Tests** — add coverage in `test/integration/mcp-tools.test.ts` (tool→pipeline
   via mock transport) and/or `test/integration/module-executor.test.ts`
   (executor→api via mock).
10. **`.claude/settings.json`** — if the tool should be auto-allowed, add
    `mcp__foundry__x` to `permissions.allow`.

Adding a **new document type** is smaller: extend the `DocumentType` enum **and**
the `COLLECTIONS` map together (they must stay in sync), then ensure
`foundry-runtime.ts`'s `getDocumentClass`/collection accessor handles it.

## Reliability pipeline contract

Every mutating tool runs through `reliability.ts`. The canonical shape is
`runMutation` (dry-run → write → derive id → read-back verify subset → rollback
on mismatch). Categories differ in which steps apply and why:

| Category | Steps | Read-back / rollback notes |
| --- | --- | --- |
| create | dry-run, write, read-back, [rollback] | `find` by new `_id`; verify `isSubset(found, verifyData ?? data)`; rollback = `delete`. |
| update | pre-read, dry-run, write, read-back, [rollback] | pre-read is the rollback baseline; verify `expandObject(data)` subset; rollback = `update` restoring touched top-level keys (`buildRestoreDiff`). |
| delete | dry-run, write | terminal: no read-back, no rollback. |
| embedded create/update | dry-run, write, read-back, [rollback] | read-back fetches the **parent** and verifies the embedded entries by `_id` under their Foundry field (`embeddedField()` from `shared`): create checks each new `_id` is present; update checks each change is a subset. On failure, create rolls back by deleting the new ids (from the write result); update restores the pre-read versions of the touched docs. |
| embedded delete | dry-run, write | terminal. |
| quest create/update/delete | dry-run, write | quests aren't queryable via `find` and Forien's Quest Log normalizes fields (e.g. status casing), so content isn't re-verified; a successful write (with an `_id` for create) is the confirmation; delete is terminal. |
| find / get_world_info / get_chat_log | find / get-world-info / get-chat-log | read-only; not mutations; single round-trip via the shared `runRead` helper. |
| upload_asset | dry-run, write | terminal: FilePicker upload, no read-back. |
| show_image | dry-run, write | terminal side effect: image popout shared to the players (falls back to `Journal.show` on the page `uuid`); nothing to read back. |
| run_macro | dry-run, write | terminal side effect: runs an existing **script** macro in the GM's browser (`args` becomes its `scope`) and returns its JSON-safe return value. Arbitrary code, so it refuses with `UNSUPPORTED` until a GM switches on the world setting "Allow the bridge to run macros" (off by default, not settable through the bridge). Dry-run resolves the macro and the setting without running it. Nothing is read back or rolled back. |
| list_changes / undo_change | read / inverse pipeline | server-side change log (`change-log.ts`). With `PipelineOptions.changes` set, `send()` snapshots update/delete targets (an extra `find` before the real write) and records each successful non-dry-run write with its **inverse command**, tagged with the connected world's key (`world.id:world.key`, the key being generated by the module). `undo_change` runs the inverse through the matching `*Reliable` pipeline (and logs it), and only in the world the change was made in; entries without a world key are never undoable. Update inverses come from `buildInverseUpdate` (shared): values that existed are restored (an explicit `null` stays `null`), fields the update added are deleted with `-=`, and read-back checks their *absence*. Deletes gain a pre-read **when the log is on**. Not logged: quests, uploads, macros. A logging failure after a successful write never fails the call; it adds a `warnings` entry to the outcome. |
| activate_scene / toggle_condition | dry-run, write | terminal side effects: `switch_scene` (activate or GM-only view) and `toggle_condition` (Foundry `toggleStatusEffect`; dry-run rejects unknown condition ids and tokens without an actor). The module reports the resulting state, which is the confirmation. |
| get_scene_state / list_scenes | read | read-only compact scene snapshot (`buildSceneState` in `shared`). |
| place_token / move_tokens / add_walls / add_lights | (scene read), then embedded create/update | composite grid-square tools in `mcp-server/src/scene-tools.ts`: read the scene grid once (`getSceneState`), convert squares → pixels with `gridToPixels`/`sceneOrigin`, then run the ordinary embedded pipelines. Square/gridless scenes only (hex → `UNSUPPORTED`). |
| show_image_file | read-file, upload, journal, page, [show] | composite: reads a local image server-side (no base64 through the model), then chains `upload_asset` → `find_documents`/`create_document` (JournalEntry) → `create_embedded` (image page) → `show_image`, each with its own pipeline. |

Step names accumulate in the `steps: string[]` returned in the `ToolOutcome`
(`{ ok, data|error, steps }`) so a caller can see exactly how far a command got.

## Tracing

For debugging against a real Foundry, the server emits a full trace to **stderr**
(never stdout — that carries the MCP JSON-RPC stream). It's on by default; set
`RELAY_TRACE=0` to mute. Each tool logs entry + outcome+steps (`▶ create_document`
… `◀ create_document ok [dry-run > write > read-back]`), and every wire command is
logged as it's sent/received (`→ create #1a2b3c4d Actor` / `← … ok|ERROR code`).
The Foundry module logs the mirror image to the browser console (`▶`/`◀` per
inbound command). The trace sink is `PipelineOptions.log`; tests pass none and
stay silent.

`dryRun` semantics: the module validates construction (`new cls(data)`,
`clone().updateSource(diff)`) and returns the would-be object **without
persisting**. The pipeline always dry-runs before writing.

## Error taxonomy (`ErrorCode`)

Stable, machine-readable codes (`shared/protocol.ts`), surfaced via
`CommandError { code, message, details? }`:

- `VALIDATION` — bad input / protocol-version mismatch.
- `AUTH` — bad/missing token, or non-GM caller (`checkEnvelopeGuards`).
- `NOT_FOUND` — target document/quest doesn't exist.
- `CONFLICT` — concurrent-modification style failure.
- `TIMEOUT` — transport timed out (`TimeoutError` → this code).
- `READBACK_MISMATCH` — write succeeded but verification failed; rolled back.
- `FORBIDDEN` — the GM's per-category bridge permission (Module Settings) does not allow this write; enforced in the executor (`checkPermission` in `shared/permissions.ts`), dry-runs included.
- `UNSUPPORTED` — type/op the runtime can't service (e.g. FQL module disabled).
- `INTERNAL` — anything else.

Guards (`checkEnvelopeGuards`) run **identically** in the module executor and the
mock: protocol version → token → GM. Keep them there, not duplicated.

## Rollback and permissions

A rollback is an ordinary write, so the GM's bridge permissions apply to it. Under the default
"no delete" level the cleanup of a failed create (delete) is **refused**; the pipeline then reports
`READBACK_MISMATCH` with `details.rollbackError` and `details.remaining` and says plainly that the
change is still in Foundry (steps `rollback`, `rollback-failed`). The "rolled back" guarantee therefore
holds only where the category allows deletes (level *Full*). This is deliberate: the bridge never
bypasses the GM's permission boundary.

## Invariants to preserve

- Protocol changes start in `packages/shared`; both ends import from it so the
  wire contract can't drift.
- Keep logic on the testable side of the two seams; keep `foundry-runtime.ts`
  and `foundry-module/index.ts` thin (they're not in CI).
- The extra read-back round-trip is a correctness guarantee, not overhead.
- Config is read in exactly one place (`mcp-server/src/config.ts`); nothing
  hardcoded.
