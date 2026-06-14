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

export interface CreateDocumentInput {
  documentType: DocumentType;
  data: Json;
}

export async function createDocumentReliable(
  transport: RelayTransport,
  input: CreateDocumentInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = [];
  const create: Command = { action: "create", documentType: input.documentType, data: input.data };

  // 1. dry-run
  steps.push("dry-run");
  const dry = await send(transport, create, true, opts);
  if (!dry.ok) return fail(steps, dry.error);

  // 2. write
  steps.push("write");
  const written = await send(transport, create, false, opts);
  if (!written.ok) return fail(steps, written.error);

  const newId = idOf(written.data);
  if (!newId) {
    return fail(steps, { code: "INTERNAL", message: "create returned no _id" });
  }

  // 3. read-back verify
  steps.push("read-back");
  const readBack = await send(
    transport,
    { action: "find", documentType: input.documentType, id: newId },
    false,
    opts,
  );
  if (!readBack.ok || !isSubset(readBack.data, input.data)) {
    steps.push("rollback");
    await send(transport, { action: "delete", documentType: input.documentType, id: newId }, false, opts);
    return fail(steps, {
      code: "READBACK_MISMATCH",
      message: "created document did not match the requested data; rolled back",
      details: { id: newId, expected: input.data, actual: readBack.ok ? readBack.data : null },
    });
  }

  return { ok: true, data: written.data, steps };
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

  // 0. pre-read snapshot (existence + rollback baseline)
  steps.push("pre-read");
  const before = await send(
    transport,
    { action: "find", documentType: input.documentType, id: input.id },
    false,
    opts,
  );
  if (!before.ok) return fail(steps, before.error);
  const snapshot = before.data as Json;

  const update: Command = {
    action: "update",
    documentType: input.documentType,
    id: input.id,
    data: input.data,
  };

  // 1. dry-run
  steps.push("dry-run");
  const dry = await send(transport, update, true, opts);
  if (!dry.ok) return fail(steps, dry.error);

  // 2. write
  steps.push("write");
  const written = await send(transport, update, false, opts);
  if (!written.ok) return fail(steps, written.error);

  // 3. read-back verify the changed fields
  steps.push("read-back");
  const expanded = expandObject(input.data);
  const after = await send(
    transport,
    { action: "find", documentType: input.documentType, id: input.id },
    false,
    opts,
  );
  if (!after.ok || !isSubset(after.data, expanded)) {
    steps.push("rollback");
    const restore = buildRestoreDiff(snapshot, expanded);
    await send(
      transport,
      { action: "update", documentType: input.documentType, id: input.id, data: restore },
      false,
      opts,
    );
    return fail(steps, {
      code: "READBACK_MISMATCH",
      message: "updated document did not match the requested data; restored previous values",
      details: { id: input.id, expected: expanded, actual: after.ok ? after.data : null },
    });
  }

  return { ok: true, data: written.data, steps };
}

/** Previous values for the top-level keys touched by `diff`, for rollback. */
function buildRestoreDiff(snapshot: Json, diff: Json): Json {
  const restore: Json = {};
  for (const key of Object.keys(diff)) {
    restore[key] = snapshot[key] ?? null;
  }
  return restore;
}
