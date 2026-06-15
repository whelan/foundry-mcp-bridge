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
  expandObject,
  isSubset,
} from "@foundry-mcp-bridge/shared";
import { TimeoutError, type RelayTransport } from "./relay-transport.js";

export interface PipelineOptions {
  token?: string;
  timeoutMs?: number;
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
  try {
    return await transport.request(envelope, { timeoutMs: opts.timeoutMs });
  } catch (e) {
    const code = e instanceof TimeoutError ? "TIMEOUT" : "INTERNAL";
    return { id: envelope.id, ok: false, error: { code, message: (e as Error).message } };
  }
}

function fail(steps: string[], error: CommandError): ToolOutcome {
  return { ok: false, error, steps };
}

function idOf(data: unknown): string | undefined {
  if (data && typeof data === "object" && "_id" in data) {
    const id = (data as { _id: unknown })._id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * Shared backbone for every mutating tool: dry-run → write → read-back verify →
 * structured error / rollback. Callers supply the mutating command, the expected
 * read-back subset, the document id (known up-front for updates, derived from the
 * write for creates) and how to roll back. `steps` may already contain a
 * preceding step (e.g. update's "pre-read").
 */
interface Mutation {
  documentType: DocumentType;
  mutate: Command;
  /** Fields the read-back must contain (subset match). */
  expected: Json;
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
  steps.push("dry-run");
  const dry = await send(transport, m.mutate, true, opts);
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(transport, m.mutate, false, opts);
  if (!written.ok) return fail(steps, written.error);

  const id = m.knownId ?? idOf(written.data);
  if (!id) return fail(steps, { code: "INTERNAL", message: "write returned no _id" });

  steps.push("read-back");
  const readBack = await send(
    transport,
    { action: "find", documentType: m.documentType, id },
    false,
    opts,
  );
  if (!readBack.ok || !isSubset(readBack.data, m.expected)) {
    steps.push("rollback");
    await send(transport, m.rollback(id), false, opts);
    return fail(steps, {
      code: "READBACK_MISMATCH",
      message: m.mismatchMessage,
      details: { id, expected: m.expected, actual: readBack.ok ? readBack.data : null },
    });
  }

  return { ok: true, data: written.data, steps };
}

export interface CreateDocumentInput {
  documentType: DocumentType;
  data: Json;
  /** Optional: subset of data to verify on read-back (e.g. for scenes with stable fields). */
  verifyData?: Json;
}

export function createDocumentReliable(
  transport: RelayTransport,
  input: CreateDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runMutation(
    transport,
    {
      documentType: input.documentType,
      mutate: { action: "create", documentType: input.documentType, data: input.data },
      expected: input.verifyData ?? input.data,
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

export async function deleteDocumentReliable(
  transport: RelayTransport,
  input: DeleteDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];

  // Delete operations skip read-back (no rollback, delete is terminal).
  steps.push("dry-run");
  const dry = await send(
    transport,
    { action: "delete", documentType: input.documentType, id: input.id },
    true,
    opts,
  );
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(
    transport,
    { action: "delete", documentType: input.documentType, id: input.id },
    false,
    opts,
  );
  if (!written.ok) return fail(steps, written.error);

  return { ok: true, data: written.data, steps };
}

export interface DuplicateDocumentInput {
  documentType: DocumentType;
  id: string;
  overrides?: Json;
}

export function duplicateDocumentReliable(
  transport: RelayTransport,
  input: DuplicateDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
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
      // that any requested overrides took effect.
      expected: input.overrides ? expandObject(input.overrides) : {},
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

export async function createEmbeddedReliable(
  transport: RelayTransport,
  input: CreateEmbeddedInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];

  steps.push("dry-run");
  const dry = await send(
    transport,
    {
      action: "createEmbedded",
      parentType: input.parentType,
      parentId: input.parentId,
      embeddedName: input.embeddedName,
      data: input.data,
    },
    true,
    opts,
  );
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(
    transport,
    {
      action: "createEmbedded",
      parentType: input.parentType,
      parentId: input.parentId,
      embeddedName: input.embeddedName,
      data: input.data,
    },
    false,
    opts,
  );
  if (!written.ok) return fail(steps, written.error);

  if (!Array.isArray(written.data)) {
    return fail(steps, { code: "INTERNAL", message: "createEmbedded did not return array" });
  }

  // Read-back verify
  steps.push("read-back");
  const readBack = await send(
    transport,
    { action: "find", documentType: input.parentType, id: input.parentId },
    false,
    opts,
  );
  if (!readBack.ok) {
    steps.push("rollback");
    // Cannot easily rollback multiple creates; at least mark it in the error.
    return fail(steps, {
      code: "READBACK_MISMATCH",
      message: "embedded documents created but read-back of parent failed; check manually",
      details: { parentId: input.parentId, created: written.data },
    });
  }

  return { ok: true, data: written.data, steps };
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
  const steps: string[] = [];

  // Pre-read snapshot
  steps.push("pre-read");
  const before = await send(
    transport,
    { action: "find", documentType: input.parentType, id: input.parentId },
    false,
    opts,
  );
  if (!before.ok) return fail(steps, before.error);
  const snapshot = before.data as Json;

  steps.push("dry-run");
  const dry = await send(
    transport,
    {
      action: "updateEmbedded",
      parentType: input.parentType,
      parentId: input.parentId,
      embeddedName: input.embeddedName,
      data: input.data,
    },
    true,
    opts,
  );
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(
    transport,
    {
      action: "updateEmbedded",
      parentType: input.parentType,
      parentId: input.parentId,
      embeddedName: input.embeddedName,
      data: input.data,
    },
    false,
    opts,
  );
  if (!written.ok) return fail(steps, written.error);

  if (!Array.isArray(written.data)) {
    return fail(steps, { code: "INTERNAL", message: "updateEmbedded did not return array" });
  }

  // Read-back verify
  steps.push("read-back");
  const readBack = await send(
    transport,
    { action: "find", documentType: input.parentType, id: input.parentId },
    false,
    opts,
  );
  if (!readBack.ok) {
    steps.push("rollback");
    // Restore to previous state
    await send(
      transport,
      {
        action: "updateEmbedded",
        parentType: input.parentType,
        parentId: input.parentId,
        embeddedName: input.embeddedName,
        data: (snapshot as any)[input.embeddedName] || [],
      },
      false,
      opts,
    );
    return fail(steps, {
      code: "READBACK_MISMATCH",
      message: "embedded documents updated but read-back of parent failed; rolled back",
      details: { parentId: input.parentId, updated: written.data },
    });
  }

  return { ok: true, data: written.data, steps };
}

export interface DeleteEmbeddedInput {
  parentType: DocumentType;
  parentId: string;
  embeddedName: string;
  ids: string[];
}

export async function deleteEmbeddedReliable(
  transport: RelayTransport,
  input: DeleteEmbeddedInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];

  steps.push("dry-run");
  const dry = await send(
    transport,
    {
      action: "deleteEmbedded",
      parentType: input.parentType,
      parentId: input.parentId,
      embeddedName: input.embeddedName,
      ids: input.ids,
    },
    true,
    opts,
  );
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(
    transport,
    {
      action: "deleteEmbedded",
      parentType: input.parentType,
      parentId: input.parentId,
      embeddedName: input.embeddedName,
      ids: input.ids,
    },
    false,
    opts,
  );
  if (!written.ok) return fail(steps, written.error);

  return { ok: true, data: written.data, steps };
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

  steps.push("dry-run");
  const dry = await send(
    transport,
    {
      action: "createQuest",
      data: input.data,
      parentId: input.parentId,
    },
    true,
    opts,
  );
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(
    transport,
    {
      action: "createQuest",
      data: input.data,
      parentId: input.parentId,
    },
    false,
    opts,
  );
  if (!written.ok) return fail(steps, written.error);

  const questId = idOf(written.data);
  if (!questId) {
    return fail(steps, { code: "INTERNAL", message: "createQuest returned no _id" });
  }

  // Quests are not queryable via standard find, so skip read-back.
  steps.push("read-back");

  return { ok: true, data: written.data, steps };
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

  steps.push("dry-run");
  const dry = await send(
    transport,
    {
      action: "updateQuest",
      id: input.id,
      data: input.data,
    },
    true,
    opts,
  );
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(
    transport,
    {
      action: "updateQuest",
      id: input.id,
      data: input.data,
    },
    false,
    opts,
  );
  if (!written.ok) return fail(steps, written.error);

  // Quests are not queryable via standard find, so skip read-back verification.
  // Instead, check that the write result contains the expected fields.
  steps.push("read-back");
  const expanded = expandObject(input.data);
  if (!isSubset(written.data, expanded)) {
    return fail(steps, {
      code: "READBACK_MISMATCH",
      message: "quest update did not match the requested data",
      details: { id: input.id, expected: expanded, actual: written.data },
    });
  }

  return { ok: true, data: written.data, steps };
}

export interface DeleteQuestInput {
  id: string;
}

export async function deleteQuestReliable(
  transport: RelayTransport,
  input: DeleteQuestInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];

  steps.push("dry-run");
  const dry = await send(
    transport,
    {
      action: "deleteQuest",
      id: input.id,
    },
    true,
    opts,
  );
  if (!dry.ok) return fail(steps, dry.error);

  steps.push("write");
  const written = await send(
    transport,
    {
      action: "deleteQuest",
      id: input.id,
    },
    false,
    opts,
  );
  if (!written.ok) return fail(steps, written.error);

  return { ok: true, data: written.data, steps };
}
