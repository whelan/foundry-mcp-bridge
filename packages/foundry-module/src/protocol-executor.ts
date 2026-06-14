/**
 * The module's command executor: guards (protocol version, auth token, GM) and
 * dispatch of a {@link CommandEnvelope} to a {@link FoundryDocumentApi}. This is
 * the testable core — it has no knowledge of WebSockets or Foundry globals, so
 * it can be exercised against the in-memory mock-foundry (see
 * docs/foundry-mcp-bridge-project-plan.md, mock-first strategy).
 */

import {
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type DocumentType,
  type ErrorCode,
  PROTOCOL_VERSION,
  ok,
  err,
} from "@foundry-mcp-bridge/shared";

export type DocData = Record<string, unknown>;

export interface ExecuteOptions {
  /** Validate construction but do not persist. */
  dryRun: boolean;
}

/** Selector for a find operation. */
export interface FindSelector {
  id?: string;
  query?: Record<string, unknown>;
}

/**
 * The narrow surface the executor needs from Foundry. The real implementation
 * (foundry-runtime.ts) calls `Actor.create`, `document.update`, embedded CRUD,
 * etc.; tests back it with the mock-foundry.
 */
export interface FoundryDocumentApi {
  create(type: DocumentType, data: DocData, opts: ExecuteOptions): Promise<DocData>;
  update(
    type: DocumentType,
    id: string,
    diff: DocData,
    opts: ExecuteOptions,
  ): Promise<DocData>;
  remove(type: DocumentType, id: string, opts: ExecuteOptions): Promise<void>;
  createEmbedded(
    parentType: DocumentType,
    parentId: string,
    embeddedName: string,
    data: DocData[],
    opts: ExecuteOptions,
  ): Promise<DocData[]>;
  updateEmbedded(
    parentType: DocumentType,
    parentId: string,
    embeddedName: string,
    data: DocData[],
    opts: ExecuteOptions,
  ): Promise<DocData[]>;
  deleteEmbedded(
    parentType: DocumentType,
    parentId: string,
    embeddedName: string,
    ids: string[],
    opts: ExecuteOptions,
  ): Promise<void>;
  find(type: DocumentType, selector: FindSelector): Promise<DocData | DocData[]>;
}

export interface ExecutorContext {
  /** Result of game.user.isGM in the real module. */
  isGM: boolean;
  /** Configured auth token; when set, envelopes must match it. */
  expectedToken?: string;
}

/** Error a {@link FoundryDocumentApi} throws to surface a structured failure. */
export class CommandExecutionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CommandExecutionError";
  }
}

export async function executeCommand(
  envelope: CommandEnvelope,
  api: FoundryDocumentApi,
  ctx: ExecutorContext,
): Promise<CommandResult> {
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return err(envelope.id, "VALIDATION", "protocol version mismatch", {
      expected: PROTOCOL_VERSION,
      received: envelope.protocolVersion,
    });
  }
  if (ctx.expectedToken !== undefined && envelope.token !== ctx.expectedToken) {
    return err(envelope.id, "AUTH", "invalid or missing token");
  }
  if (!ctx.isGM) {
    return err(envelope.id, "AUTH", "GM privileges required");
  }

  const opts: ExecuteOptions = { dryRun: envelope.dryRun };
  try {
    const data = await dispatch(envelope.command, api, opts);
    return ok(envelope.id, data);
  } catch (e) {
    if (e instanceof CommandExecutionError) {
      return err(envelope.id, e.code, e.message, e.details);
    }
    return err(envelope.id, "INTERNAL", (e as Error).message);
  }
}

async function dispatch(
  command: Command,
  api: FoundryDocumentApi,
  opts: ExecuteOptions,
): Promise<unknown> {
  switch (command.action) {
    case "create":
      return api.create(command.documentType, command.data, opts);
    case "update":
      return api.update(command.documentType, command.id, command.data, opts);
    case "delete":
      await api.remove(command.documentType, command.id, opts);
      return { _id: command.id, deleted: true };
    case "createEmbedded":
      return api.createEmbedded(
        command.parentType,
        command.parentId,
        command.embeddedName,
        command.data,
        opts,
      );
    case "updateEmbedded":
      return api.updateEmbedded(
        command.parentType,
        command.parentId,
        command.embeddedName,
        command.data,
        opts,
      );
    case "deleteEmbedded":
      await api.deleteEmbedded(
        command.parentType,
        command.parentId,
        command.embeddedName,
        command.ids,
        opts,
      );
      return { deleted: command.ids };
    case "find":
      return api.find(command.documentType, { id: command.id, query: command.query });
  }
}
