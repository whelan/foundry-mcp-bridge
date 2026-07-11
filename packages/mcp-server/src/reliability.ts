/**
 * The reliability pipeline every mutating tool runs (live-api-plan §11):
 *   validate → dry-run → write → read-back verify → structured error / rollback.
 *
 * Depends only on a {@link RelayTransport}, so it is fully testable against the
 * mock-foundry (including injected timeouts and read-back mismatches).
 */

import { randomUUID } from "node:crypto";
import {
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type CommandError,
  type DocumentType,
  type Json,
  PROTOCOL_VERSION,
  EMBEDDED_FIELDS,
  embeddedField,
  err,
  expandObject,
  isSubset,
} from "@foundry-mcp-bridge/shared";
import { TimeoutError, type RelayTransport } from "./relay-transport.js";

export interface PipelineOptions {
  token?: string;
  timeoutMs?: number;
  /** Optional trace sink; when set, every wire command + result is logged. */
  log?: (line: string) => void;
}

export type ToolOutcome =
  | { ok: true; data: unknown; steps: string[] }
  | { ok: false; error: CommandError; steps: string[] };

function makeEnvelope(command: Command, dryRun: boolean, token?: string): CommandEnvelope {
  return {
    id: randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    dryRun,
    token,
    command,
  };
}

async function send(
  transport: RelayTransport,
  command: Command,
  dryRun: boolean,
  opts: PipelineOptions,
): Promise<CommandResult> {
  const envelope = makeEnvelope(command, dryRun, opts.token);
  // Build the (allocating) trace tag only when a sink is attached.
  const tag = opts.log
    ? `${command.action}${dryRun ? " (dry-run)" : ""} #${envelope.id.slice(0, 8)}`
    : "";
  opts.log?.(`  → ${tag} ${commandSummary(command)}`);
  try {
    const res = await transport.request(envelope, { timeoutMs: opts.timeoutMs });
    opts.log?.(
      res.ok ? `  ← ${tag} ok` : `  ← ${tag} ERROR ${res.error.code}: ${res.error.message}`,
    );
    return res;
  } catch (e) {
    const code = e instanceof TimeoutError ? "TIMEOUT" : "INTERNAL";
    opts.log?.(`  ← ${tag} ${code}: ${(e as Error).message}`);
    return err(envelope.id, code, (e as Error).message);
  }
}

/** A short, id/type-focused summary of a command for trace logs (typed, exhaustive). */
function commandSummary(c: Command): string {
  switch (c.action) {
    case "create":
      return c.documentType;
    case "update":
    case "delete":
    case "duplicate":
      return `${c.documentType} id=${c.id}`;
    case "find":
      return c.id ? `${c.documentType} id=${c.id}` : c.documentType;
    case "createEmbedded":
    case "updateEmbedded":
      return `${c.parentType}/${c.embeddedName} parent=${c.parentId} n=${c.data.length}`;
    case "deleteEmbedded":
      return `${c.parentType}/${c.embeddedName} parent=${c.parentId} ids=${c.ids.length}`;
    case "createQuest":
      return c.parentId ? `parent=${c.parentId}` : "quest";
    case "updateQuest":
    case "deleteQuest":
      return `id=${c.id}`;
    case "uploadAsset":
      return `${c.target}/${c.filename}`;
    case "browseAssets":
      return `${c.source}:${c.target}`;
    case "batchUploadAssets":
      return `batch-upload ${c.files.length} → ${c.target}`;
    case "getWorldInfo":
      return "";
    case "searchCompendium":
      return `${c.documentType} nameQuery=${c.nameQuery}`;
    case "importFromCompendium":
      return `uuid=${c.uuid.slice(0, 20)}...`;
    case "importEmbeddedFromCompendium":
      return `${c.parentType}/${c.embeddedName} parent=${c.parentId} n=${c.uuids.length}`;
  }
}

/**
 * Read-only command: a single round-trip (no dry-run, no read-back). Shares the
 * envelope/timeout/error handling of {@link send} so read tools don't hand-roll it.
 */
export async function runRead(
  transport: RelayTransport,
  command: Command,
  stepName: string,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps = [stepName];
  const res = await send(transport, command, false, opts);
  return res.ok
    ? { ok: true, data: res.data, steps }
    : { ok: false, error: res.error, steps };
}

function fail(steps: string[], error: CommandError): ToolOutcome {
  return { ok: false, error, steps };
}

/**
 * Structured VALIDATION failure for input rejected before the pipeline runs
 * at all — no transport contact, nothing to roll back. Used to reject a
 * caller-supplied diff/patch/overrides/data object that's empty (see
 * `isEmptyDiff`): for update/duplicate/import/updateEmbedded that would
 * otherwise be a no-op write reading back as "unchanged" and reporting
 * success; for create, an empty `expected` would make `isSubset` vacuously
 * pass regardless of what was actually written. Either way the caller's
 * intent is silently dropped without this guard. Enforced inside each
 * `xxxReliable` function itself (not just at the tools.ts boundary) so any
 * future direct caller gets the guard for free, instead of a raw
 * `ToolOutcome` object literal duplicated at every call site.
 */
function validationFailure(message: string): ToolOutcome {
  return fail(["validate"], { code: "VALIDATION", message });
}

/** True when a dot-notation object was supplied but has nothing safe left to
 * apply beyond `ignoreKeys` (e.g. every real key was stripped by
 * `filterUnsafePaths`, or the caller passed `{}` outright). `undefined`
 * itself is not empty in this sense — it means "not supplied", which is
 * legitimate wherever the field is optional (duplicate's overrides, import's
 * patch); only a *supplied-but-empty* object is the caller-intent-silently-
 * dropped case this predicate exists to catch. `ignoreKeys` lets a per-entry
 * check (e.g. an embedded diff's required `_id`) share this same predicate
 * instead of hand-rolling its own threshold. */
function isEmptyDiff(data: Json | undefined, ignoreKeys: string[] = []): boolean {
  if (data === undefined) return false;
  return Object.keys(data).filter((k) => !ignoreKeys.includes(k)).length === 0;
}

function idOf(data: unknown): string | undefined {
  if (data && typeof data === "object" && "_id" in data) {
    const id = (data as { _id: unknown })._id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * Fallback read-back check for clone-shaped mutations (duplicate, import) that
 * have no caller-supplied data to verify against: confirm the write's own
 * name (or, failing that, type) survived the read-back. An empty object would
 * make `isSubset` vacuously pass, silently disabling the mismatch/rollback
 * safety net, so this only degrades to `{}` when neither field is present.
 */
function nameOrTypeFallback(written: unknown): Json {
  const w = written as { name?: unknown; type?: unknown } | null;
  if (typeof w?.name === "string") return { name: w.name };
  if (typeof w?.type === "string") return { type: w.type };
  return {};
}

/**
 * Resolves a clone-shaped mutation's `expected`: expands a non-empty
 * caller-supplied dot-notation object (so `isSubset` matches the nested
 * read-back document instead of a literal "a.b.c" key), or falls back to
 * `nameOrTypeFallback` when absent or empty — see its doc comment for why
 * empty must never be used directly as `expected`.
 */
function expectedFromOverrides(overrides: Json | undefined): Json | ((written: unknown) => Json) {
  return overrides && !isEmptyDiff(overrides) ? expandObject(overrides) : nameOrTypeFallback;
}

/**
 * The dry-run → write phase shared by every mutating tool: dry-runs the command
 * (push "dry-run"), then writes it (push "write"), short-circuiting on either
 * failure. Returns the write payload on success, or a ready-made failure outcome.
 */
type WritePhase = { ok: true; data: unknown } | { ok: false; outcome: ToolOutcome };

async function dryRunThenWrite(
  transport: RelayTransport,
  command: Command,
  opts: PipelineOptions,
  steps: string[],
): Promise<WritePhase> {
  steps.push("dry-run");
  const dry = await send(transport, command, true, opts);
  if (!dry.ok) return { ok: false, outcome: fail(steps, dry.error) };

  steps.push("write");
  const written = await send(transport, command, false, opts);
  if (!written.ok) return { ok: false, outcome: fail(steps, written.error) };

  return { ok: true, data: written.data };
}

/** Terminal mutation (deletes): dry-run → write, no read-back or rollback. */
async function runTerminal(
  transport: RelayTransport,
  command: Command,
  opts: PipelineOptions,
): Promise<ToolOutcome> {
  const steps: string[] = [];
  const phase = await dryRunThenWrite(transport, command, opts, steps);
  return phase.ok ? { ok: true, data: phase.data, steps } : phase.outcome;
}

/**
 * Shared backbone for read-back-verified mutations: dry-run → write → read-back
 * verify → structured error / rollback. Callers supply the mutating command, the
 * expected read-back subset, the document id (known up-front for updates, derived
 * from the write for creates) and how to roll back. `steps` may already contain a
 * preceding step (e.g. update's "pre-read").
 */
interface Mutation {
  documentType: DocumentType;
  mutate: Command;
  /**
   * Fields the read-back must contain (subset match). Most callers know this
   * up front (the data they sent); a few (e.g. import) only know it depends on
   * what the write actually echoed back, so a function of the write result is
   * also accepted.
   */
  expected: Json | ((written: unknown) => Json);
  /** Known target id (updates); creates derive it from the write result. */
  knownId?: string;
  /** Rollback command run when read-back fails. */
  rollback: (id: string) => Command;
  /** Message for the READBACK_MISMATCH error. */
  mismatchMessage: string;
}

async function runMutation(
  transport: RelayTransport,
  m: Mutation,
  opts: PipelineOptions,
  steps: string[],
): Promise<ToolOutcome> {
  const phase = await dryRunThenWrite(transport, m.mutate, opts, steps);
  if (!phase.ok) return phase.outcome;
  const written = phase.data;

  const id = m.knownId ?? idOf(written);
  if (!id) return fail(steps, { code: "INTERNAL", message: "write returned no _id" });

  const expected = typeof m.expected === "function" ? m.expected(written) : m.expected;

  steps.push("read-back");
  const readBack = await send(
    transport,
    { action: "find", documentType: m.documentType, id },
    false,
    opts,
  );
  if (!readBack.ok || !isSubset(readBack.data, expected)) {
    steps.push("rollback");
    await send(transport, m.rollback(id), false, opts);
    return fail(steps, {
      code: "READBACK_MISMATCH",
      message: m.mismatchMessage,
      details: { id, expected, actual: readBack.ok ? readBack.data : null },
    });
  }

  return { ok: true, data: written, steps };
}

export interface CreateDocumentInput {
  documentType: DocumentType;
  data: Json;
  /** Optional: subset of data to verify on read-back (e.g. for scenes with stable fields). */
  verifyData?: Json;
  /** Preserve an explicit data._id (Foundry keepId) instead of minting a new one. */
  keepId?: boolean;
}

export async function createDocumentReliable(
  transport: RelayTransport,
  input: CreateDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Unlike duplicate/import, a document created from nothing has no
  // name/type for nameOrTypeFallback to degrade to, so an empty data/
  // verifyData must be rejected outright (see validationFailure/isEmptyDiff).
  const expected = input.verifyData ?? input.data;
  if (isEmptyDiff(expected)) {
    return validationFailure("create data has no fields to verify on read-back");
  }

  return runMutation(
    transport,
    {
      documentType: input.documentType,
      mutate: {
        action: "create",
        documentType: input.documentType,
        data: input.data,
        keepId: input.keepId,
      },
      expected,
      rollback: (id) => ({ action: "delete", documentType: input.documentType, id }),
      mismatchMessage: "created document did not match the requested data; rolled back",
    },
    opts,
    [],
  );
}

export interface UpdateDocumentInput {
  documentType: DocumentType;
  id: string;
  data: Json;
}

export async function updateDocumentReliable(
  transport: RelayTransport,
  input: UpdateDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // data is required, so empty here always means "nothing safe survived
  // filtering" (see validationFailure/isEmptyDiff).
  if (isEmptyDiff(input.data)) {
    return validationFailure("update data has no safe fields to apply");
  }

  const steps: string[] = [];

  // Pre-read for existence and as the rollback baseline.
  steps.push("pre-read");
  const before = await send(
    transport,
    { action: "find", documentType: input.documentType, id: input.id },
    false,
    opts,
  );
  if (!before.ok) return fail(steps, before.error);
  const snapshot = before.data as Json;
  const expected = expandObject(input.data);

  return runMutation(
    transport,
    {
      documentType: input.documentType,
      mutate: { action: "update", documentType: input.documentType, id: input.id, data: input.data },
      expected,
      knownId: input.id,
      rollback: (id) => ({
        action: "update",
        documentType: input.documentType,
        id,
        data: buildRestoreDiff(snapshot, expected),
      }),
      mismatchMessage: "updated document did not match the requested data; restored previous values",
    },
    opts,
    steps,
  );
}

/** Previous values for the top-level keys touched by `diff`, for rollback. */
function buildRestoreDiff(snapshot: Json, diff: Json): Json {
  const restore: Json = {};
  for (const key of Object.keys(diff)) {
    restore[key] = snapshot[key] ?? null;
  }
  return restore;
}

export interface DeleteDocumentInput {
  documentType: DocumentType;
  id: string;
}

export function deleteDocumentReliable(
  transport: RelayTransport,
  input: DeleteDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Delete is terminal: no read-back, no rollback.
  return runTerminal(
    transport,
    { action: "delete", documentType: input.documentType, id: input.id },
    opts,
  );
}

export interface DuplicateDocumentInput {
  documentType: DocumentType;
  id: string;
  overrides?: Json;
}

export async function duplicateDocumentReliable(
  transport: RelayTransport,
  input: DuplicateDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // overrides is optional (undefined = clone as-is); only reject when
  // explicitly supplied but empty (see isEmptyDiff).
  if (isEmptyDiff(input.overrides)) {
    return validationFailure("duplicate overrides has no safe fields to apply");
  }

  return runMutation(
    transport,
    {
      documentType: input.documentType,
      mutate: {
        action: "duplicate",
        documentType: input.documentType,
        id: input.id,
        overrides: input.overrides,
      },
      // The copy's _id comes from the write; read-back confirms it exists and
      // that any requested overrides took effect (or falls back to a name/type
      // check when there's nothing override-specific to verify).
      expected: expectedFromOverrides(input.overrides),
      rollback: (id) => ({ action: "delete", documentType: input.documentType, id }),
      mismatchMessage: "duplicated document did not match the requested overrides; rolled back",
    },
    opts,
    [],
  );
}

export interface CreateEmbeddedInput {
  parentType: DocumentType;
  parentId: string;
  embeddedName: string;
  data: Json[];
}

/**
 * Embedded create/update share a shape: dry-run → write (an array result) →
 * read-back the **parent** (embedded content isn't deep-verified) → on failure
 * roll back and return READBACK_MISMATCH. They differ only in the write command,
 * how the rollback is derived, and the noun used in messages/details.
 */
async function runEmbeddedMutation(
  transport: RelayTransport,
  args: {
    write: Command;
    parentType: DocumentType;
    parentId: string;
    noun: "created" | "updated";
    /** Verify the write took effect in the re-read parent (by embedded `_id`). */
    verify: (parent: Json, written: unknown[]) => boolean;
    /** Build the rollback command from the write result, or null if none applies. */
    deriveRollback: (written: unknown[]) => Command | null;
  },
  opts: PipelineOptions,
  steps: string[],
): Promise<ToolOutcome> {
  const phase = await dryRunThenWrite(transport, args.write, opts, steps);
  if (!phase.ok) return phase.outcome;
  if (!Array.isArray(phase.data)) {
    return fail(steps, { code: "INTERNAL", message: `${args.write.action} did not return array` });
  }
  const written = phase.data;

  // Read back the parent and verify the embedded entries actually landed.
  steps.push("read-back");
  const readBack = await send(
    transport,
    { action: "find", documentType: args.parentType, id: args.parentId },
    false,
    opts,
  );
  if (readBack.ok && args.verify(readBack.data as Json, written)) {
    return { ok: true, data: written, steps };
  }

  const rollback = args.deriveRollback(written);
  if (rollback) {
    steps.push("rollback");
    await send(transport, rollback, false, opts);
  }
  return fail(steps, {
    code: "READBACK_MISMATCH",
    message: rollback
      ? `embedded documents ${args.noun} but read-back verification failed; rolled back`
      : `embedded documents ${args.noun} but read-back verification failed and nothing to restore; check manually`,
    details: { parentId: args.parentId, [args.noun]: written },
  });
}

/**
 * Embedded entries on a parent snapshot under their Foundry collection field, or
 * `null` when the embeddedName has no known field mapping — callers treat `null`
 * as "can't locate; don't verify/roll back" rather than guessing the wrong field.
 */
function embeddedEntries(parent: Json, embeddedName: string): Json[] | null {
  if (!(embeddedName in EMBEDDED_FIELDS)) return null;
  const arr = parent[embeddedField(embeddedName)];
  return Array.isArray(arr) ? (arr as Json[]) : [];
}

export function createEmbeddedReliable(
  transport: RelayTransport,
  input: CreateEmbeddedInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runEmbeddedMutation(
    transport,
    {
      write: {
        action: "createEmbedded",
        parentType: input.parentType,
        parentId: input.parentId,
        embeddedName: input.embeddedName,
        data: input.data,
      },
      parentType: input.parentType,
      parentId: input.parentId,
      noun: "created",
      // Verify each new embedded doc is present in the re-read parent by _id.
      verify: (parent, written) => {
        const entries = embeddedEntries(parent, input.embeddedName);
        if (!entries) return true; // unmapped: can't locate; trust parent-loaded
        const ids = written.map(idOf).filter((id): id is string => !!id);
        if (ids.length === 0) return true; // can't identify; parent loaded is best we have
        const present = new Set(entries.map(idOf));
        return ids.every((id) => present.has(id));
      },
      // The write result carries the new ids, so we can delete them on rollback.
      deriveRollback: (written) => {
        const ids = written.map(idOf).filter((id): id is string => !!id);
        return ids.length
          ? {
              action: "deleteEmbedded",
              parentType: input.parentType,
              parentId: input.parentId,
              embeddedName: input.embeddedName,
              ids,
            }
          : null;
      },
    },
    opts,
    [],
  );
}

export interface UpdateEmbeddedInput {
  parentType: DocumentType;
  parentId: string;
  embeddedName: string;
  data: Array<Json & { _id: string }>;
}

export async function updateEmbeddedReliable(
  transport: RelayTransport,
  input: UpdateEmbeddedInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Each entry always carries _id, so exclude it from the emptiness check
  // (see validationFailure/isEmptyDiff) -- an entry with nothing else would
  // trivially "verify" on read-back, since it's found by that same _id.
  const emptyIds = input.data.filter((d) => isEmptyDiff(d, ["_id"])).map((d) => d._id);
  if (emptyIds.length > 0) {
    return validationFailure(`update data for _id=${emptyIds.join(", ")} has no safe fields to apply`);
  }

  const steps: string[] = [];

  // Pre-read snapshot is the rollback baseline.
  steps.push("pre-read");
  const before = await send(
    transport,
    { action: "find", documentType: input.parentType, id: input.parentId },
    false,
    opts,
  );
  if (!before.ok) return fail(steps, before.error);
  const snapshot = before.data as Json;
  const updatedIds = new Set(input.data.map((d) => d._id));

  return runEmbeddedMutation(
    transport,
    {
      write: {
        action: "updateEmbedded",
        parentType: input.parentType,
        parentId: input.parentId,
        embeddedName: input.embeddedName,
        data: input.data,
      },
      parentType: input.parentType,
      parentId: input.parentId,
      noun: "updated",
      // Verify each requested change is reflected in the re-read parent.
      verify: (parent) => {
        const entries = embeddedEntries(parent, input.embeddedName);
        if (!entries) return true; // unmapped: can't locate; don't false-fail
        const byId = new Map(entries.map((e) => [idOf(e), e] as const));
        return input.data.every((d) => {
          const actual = byId.get(d._id);
          return actual != null && isSubset(actual, expandObject(d));
        });
      },
      // Restore the pre-update versions of the touched docs. (`?? []` only
      // satisfies the type: an unmapped type returns true from verify and never
      // reaches rollback, so embeddedEntries is non-null here in practice.)
      deriveRollback: () => {
        const prior = (embeddedEntries(snapshot, input.embeddedName) ?? []).filter((e) => {
          const id = idOf(e);
          return id != null && updatedIds.has(id);
        }) as Array<Json & { _id: string }>;
        return prior.length
          ? {
              action: "updateEmbedded",
              parentType: input.parentType,
              parentId: input.parentId,
              embeddedName: input.embeddedName,
              data: prior,
            }
          : null;
      },
    },
    opts,
    steps,
  );
}

export interface DeleteEmbeddedInput {
  parentType: DocumentType;
  parentId: string;
  embeddedName: string;
  ids: string[];
}

export function deleteEmbeddedReliable(
  transport: RelayTransport,
  input: DeleteEmbeddedInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Terminal like delete: dry-run → write, no read-back/rollback.
  return runTerminal(
    transport,
    {
      action: "deleteEmbedded",
      parentType: input.parentType,
      parentId: input.parentId,
      embeddedName: input.embeddedName,
      ids: input.ids,
    },
    opts,
  );
}

export interface CreateQuestInput {
  /** Quest data: name, status, giver, etc. */
  data?: Json;
  /** Optional parent quest id for subquests. */
  parentId?: string;
}

export async function createQuestReliable(
  transport: RelayTransport,
  input: CreateQuestInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];
  const phase = await dryRunThenWrite(
    transport,
    { action: "createQuest", data: input.data, parentId: input.parentId },
    opts,
    steps,
  );
  if (!phase.ok) return phase.outcome;

  if (!idOf(phase.data)) {
    return fail(steps, { code: "INTERNAL", message: "createQuest returned no _id" });
  }

  // Quests aren't queryable via find, and Forien's Quest Log normalizes fields
  // (e.g. status casing), so the write echo can't be content-verified without
  // false failures. A successful write returning an _id is the confirmation.
  return { ok: true, data: phase.data, steps };
}

export interface UpdateQuestInput {
  id: string;
  data: Json;
}

export async function updateQuestReliable(
  transport: RelayTransport,
  input: UpdateQuestInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];
  const phase = await dryRunThenWrite(
    transport,
    { action: "updateQuest", id: input.id, data: input.data },
    opts,
    steps,
  );
  if (!phase.ok) return phase.outcome;

  // Not queryable via find and module-normalized (see createQuest); the module's
  // successful write is the confirmation rather than an unreliable echo compare.
  return { ok: true, data: phase.data, steps };
}

export interface DeleteQuestInput {
  id: string;
}

export function deleteQuestReliable(
  transport: RelayTransport,
  input: DeleteQuestInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Terminal: dry-run → write, no read-back/rollback.
  return runTerminal(transport, { action: "deleteQuest", id: input.id }, opts);
}

export interface BrowseAssetsInput {
  source: "data" | "forgevtt";
  target: string;
  extensions?: string[];
}

export function browseAssetsReliable(
  transport: RelayTransport,
  input: BrowseAssetsInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runRead(
    transport,
    { action: "browseAssets", source: input.source, target: input.target, extensions: input.extensions },
    "browse-assets",
    opts,
  );
}

export interface UploadAssetInput {
  source: "data" | "forgevtt";
  target: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}

export function uploadAssetReliable(
  transport: RelayTransport,
  input: UploadAssetInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Terminal write: dry-run validates the target, write uploads. No read-back
  // (uploads aren't document reads); the write result carries the stored path.
  return runTerminal(
    transport,
    {
      action: "uploadAsset",
      source: input.source,
      target: input.target,
      filename: input.filename,
      contentBase64: input.contentBase64,
      mimeType: input.mimeType,
    },
    opts,
  );
}

export interface BatchUploadAssetsInput {
  source: "data" | "forgevtt";
  target: string;
  files: Array<{ filename: string; contentBase64: string; mimeType?: string }>;
  skipExisting?: boolean;
}

export function batchUploadAssetsReliable(
  transport: RelayTransport,
  input: BatchUploadAssetsInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Terminal write: dry-run validates, write uploads each file. No read-back.
  return runTerminal(
    transport,
    {
      action: "batchUploadAssets",
      source: input.source,
      target: input.target,
      files: input.files,
      skipExisting: input.skipExisting ?? false,
    },
    opts,
  );
}

export interface SearchCompendiumInput {
  packScope?: string;
  documentType: DocumentType;
  nameQuery: string;
}

export function searchCompendiumReliable(
  transport: RelayTransport,
  input: SearchCompendiumInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runRead(
    transport,
    {
      action: "searchCompendium",
      packScope: input.packScope,
      documentType: input.documentType,
      nameQuery: input.nameQuery,
    },
    "search-compendium",
    opts,
  );
}

export interface ImportFromCompendiumInput {
  documentType: DocumentType;
  uuid: string;
  patch?: Json;
  folderId?: string;
}

export async function importFromCompendiumReliable(
  transport: RelayTransport,
  input: ImportFromCompendiumInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // patch is optional (undefined = clone as-is); only reject when explicitly
  // supplied but empty (see isEmptyDiff).
  if (isEmptyDiff(input.patch)) {
    return validationFailure("import patch has no safe fields to apply");
  }

  return runMutation(
    transport,
    {
      documentType: input.documentType,
      mutate: {
        action: "importFromCompendium",
        documentType: input.documentType,
        uuid: input.uuid,
        patch: input.patch,
        folderId: input.folderId,
      },
      // A patch names concrete fields to verify (expanded from dot-notation
      // to match the nested read-back document); without one, fall back to
      // confirming the write's own name/type survived the read-back.
      expected: expectedFromOverrides(input.patch),
      rollback: (id) => ({ action: "delete", documentType: input.documentType, id }),
      mismatchMessage: "imported document did not match expected after read-back; rolled back",
    },
    opts,
    [],
  );
}

export interface ImportEmbeddedFromCompendiumInput {
  parentType: DocumentType;
  parentId: string;
  embeddedName: string;
  uuids: Array<{ uuid: string; patch?: Json }>;
}

export async function importEmbeddedFromCompendiumReliable(
  transport: RelayTransport,
  input: ImportEmbeddedFromCompendiumInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Same emptiness guard as importFromCompendiumReliable, applied per-entry:
  // an entry's patch is optional (undefined = clone as-is), but a supplied-
  // and-empty patch silently drops caller intent (see isEmptyDiff).
  const badEntry = input.uuids.find((u) => isEmptyDiff(u.patch));
  if (badEntry) {
    return validationFailure(`patch for uuid ${badEntry.uuid} has no safe fields to apply`);
  }

  return runEmbeddedMutation(
    transport,
    {
      write: {
        action: "importEmbeddedFromCompendium",
        parentType: input.parentType,
        parentId: input.parentId,
        embeddedName: input.embeddedName,
        uuids: input.uuids,
      },
      parentType: input.parentType,
      parentId: input.parentId,
      noun: "created",
      verify: (parent, written) => {
        const entries = embeddedEntries(parent, input.embeddedName);
        if (!entries) return true;
        const ids = written.map(idOf).filter((id): id is string => !!id);
        if (ids.length === 0) return true;
        const present = new Set(entries.map(idOf));
        return ids.every((id) => present.has(id));
      },
      deriveRollback: (written) => {
        const ids = written.map(idOf).filter((id): id is string => !!id);
        return ids.length
          ? {
              action: "deleteEmbedded",
              parentType: input.parentType,
              parentId: input.parentId,
              embeddedName: input.embeddedName,
              ids,
            }
          : null;
      },
    },
    opts,
    [],
  );
}
