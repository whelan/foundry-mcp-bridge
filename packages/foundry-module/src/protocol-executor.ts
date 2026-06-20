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
  checkEnvelopeGuards,
  ok,
  err,
} from "@foundry-mcp-bridge/shared";

export type DocData = Record<string, unknown>;

export interface ExecuteOptions {
  /** Validate construction but do not persist. */
  dryRun: boolean;
}

/** Create-only options: preserve an explicit `data._id` (Foundry keepId). */
export interface CreateOptions extends ExecuteOptions {
  keepId?: boolean;
}

/** Selector for a find operation. */
export interface FindSelector {
  id?: string;
  query?: Record<string, unknown>;
}

/** A folder in the world, used to resolve `folder` ids when importing. */
export interface WorldFolder {
  _id: string;
  name: string;
  /** The document type the folder organizes, e.g. "Actor", "JournalEntry". */
  type: string;
}

/** Read-only snapshot of the world: versions, game system and folders. */
export interface WorldInfo {
  foundryVersion: string;
  system: { id: string; version: string; title?: string };
  world: { id: string; title: string };
  folders: WorldFolder[];
  /** The Forge hosting detection. active=true when running on forge-vtt.com. */
  forge: { active: boolean; userId: string | null };
}

/** Parameters for an asset upload via Foundry's FilePicker. */
export interface UploadAssetParams {
  source: "data" | "forgevtt";
  target: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}

/** Parameters for browsing assets via Foundry's FilePicker. */
export interface BrowseAssetsParams {
  source: "data" | "forgevtt";
  target: string;
  extensions?: string[];
}

/** Parameters for a batch upload via Foundry's FilePicker. */
export interface BatchUploadAssetsParams {
  source: "data" | "forgevtt";
  target: string;
  files: Array<{ filename: string; contentBase64: string; mimeType?: string }>;
  skipExisting?: boolean;
}

/**
 * The narrow surface the executor needs from Foundry. The real implementation
 * (foundry-runtime.ts) calls `Actor.create`, `document.update`, embedded CRUD,
 * etc.; tests back it with the mock-foundry.
 */
export interface FoundryDocumentApi {
  create(type: DocumentType, data: DocData, opts: CreateOptions): Promise<DocData>;
  update(
    type: DocumentType,
    id: string,
    diff: DocData,
    opts: ExecuteOptions,
  ): Promise<DocData>;
  remove(type: DocumentType, id: string, opts: ExecuteOptions): Promise<void>;
  duplicate(
    type: DocumentType,
    id: string,
    overrides: DocData | undefined,
    opts: ExecuteOptions,
  ): Promise<DocData>;
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
  getWorldInfo(): Promise<WorldInfo>;
  uploadAsset(params: UploadAssetParams, opts: ExecuteOptions): Promise<{ path: string }>;
  browseAssets(params: BrowseAssetsParams, opts: ExecuteOptions): Promise<{ dirs: string[]; files: string[]; target: string }>;
  batchUploadAssets(
    params: BatchUploadAssetsParams,
    opts: ExecuteOptions,
  ): Promise<Array<{ filename: string; path: string; skipped?: boolean }>>;
  createQuest(data: DocData | undefined, parentId: string | undefined, opts: ExecuteOptions): Promise<DocData>;
  updateQuest(id: string, data: DocData, opts: ExecuteOptions): Promise<DocData>;
  deleteQuest(id: string, opts: ExecuteOptions): Promise<void>;
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
  const guardError = checkEnvelopeGuards(envelope, ctx);
  if (guardError) return { id: envelope.id, ok: false, error: guardError };

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
      return api.create(command.documentType, command.data, { ...opts, keepId: command.keepId });
    case "update":
      return api.update(command.documentType, command.id, command.data, opts);
    case "delete":
      await api.remove(command.documentType, command.id, opts);
      return { _id: command.id, deleted: true };
    case "duplicate":
      return api.duplicate(command.documentType, command.id, command.overrides, opts);
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
    case "getWorldInfo":
      return api.getWorldInfo();
    case "uploadAsset":
      return api.uploadAsset(
        {
          source: command.source,
          target: command.target,
          filename: command.filename,
          contentBase64: command.contentBase64,
          mimeType: command.mimeType,
        },
        opts,
      );
    case "browseAssets":
      return api.browseAssets(
        { source: command.source, target: command.target, extensions: command.extensions },
        opts,
      );
    case "batchUploadAssets":
      return api.batchUploadAssets(
        { source: command.source, target: command.target, files: command.files, skipExisting: command.skipExisting },
        opts,
      );
    case "createQuest":
      return api.createQuest(command.data, command.parentId, opts);
    case "updateQuest":
      return api.updateQuest(command.id, command.data, opts);
    case "deleteQuest":
      await api.deleteQuest(command.id, opts);
      return { _id: command.id, deleted: true };
  }
}
