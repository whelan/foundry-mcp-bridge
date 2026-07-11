import { z } from "zod";

/**
 * Wire contract shared by the MCP server and the Foundry module. Keeping the
 * schemas in one package means the protocol can never drift between the two
 * ends. See docs/foundry-live-api-plan.md §6.
 */

export const PROTOCOL_VERSION = "1" as const;

/**
 * Document types the bridge knows how to address. Quests are intentionally NOT
 * a plain document type: they are created through Forien's Quest Log API
 * (see §7.1) and modelled separately by the executor / mock.
 */
export const DocumentType = z.enum([
  "Actor",
  "Scene",
  "JournalEntry",
  "RollTable",
  "Item",
  "Macro",
  "Playlist",
  "Folder",
]);
export type DocumentType = z.infer<typeof DocumentType>;

/**
 * World-collection name for each document type (Foundry's db key segment and
 * the `game.<collection>` accessor). Shared so the module, the mock and any key
 * formatting stay in lockstep when a document type is added.
 */
export const COLLECTIONS: Record<DocumentType, string> = {
  Actor: "actors",
  Scene: "scenes",
  JournalEntry: "journal",
  RollTable: "tables",
  Item: "items",
  Macro: "macros",
  Playlist: "playlists",
  // Folders organize other documents; `data.type` names which type they hold.
  Folder: "folders",
};

/**
 * Field name an embedded document collection lives under on its parent (Foundry's
 * `Token` → `tokens`, `JournalEntryPage` → `pages`, …). Single source of truth so
 * the mock's key formatting, the module, and the server's read-back verification
 * all agree. Unknown names fall back to a lowercased guess.
 */
export const EMBEDDED_FIELDS: Record<string, string> = {
  Token: "tokens",
  AmbientLight: "lights",
  Note: "notes",
  ActiveEffect: "effects",
  Item: "items",
  Wall: "walls",
  AmbientSound: "sounds",
  Drawing: "drawings",
  MeasuredTemplate: "templates",
  Tile: "tiles",
  Region: "regions",
  // v10+ JournalEntry content lives in embedded JournalEntryPage documents.
  JournalEntryPage: "pages",
};

export function embeddedField(embeddedName: string): string {
  return EMBEDDED_FIELDS[embeddedName] ?? embeddedName.toLowerCase();
}

/** Arbitrary Foundry document data — validated structurally, not field-by-field. */
const DocumentData = z.record(z.string(), z.unknown());

export const CreateCommand = z.object({
  action: z.literal("create"),
  documentType: DocumentType,
  data: DocumentData,
  /**
   * Preserve an explicit `data._id` instead of letting Foundry mint a new one
   * (Foundry's `{ keepId: true }`). Used to re-import extracted documents under
   * their original ids so cross-references stay intact.
   */
  keepId: z.boolean().optional(),
});
export type CreateCommand = z.infer<typeof CreateCommand>;

export const UpdateCommand = z.object({
  action: z.literal("update"),
  documentType: DocumentType,
  id: z.string().min(1),
  /** Partial diff merged with Foundry document.update() semantics (§7.2). */
  data: DocumentData,
});
export type UpdateCommand = z.infer<typeof UpdateCommand>;

export const DeleteCommand = z.object({
  action: z.literal("delete"),
  documentType: DocumentType,
  id: z.string().min(1),
});
export type DeleteCommand = z.infer<typeof DeleteCommand>;

export const DuplicateCommand = z.object({
  action: z.literal("duplicate"),
  documentType: DocumentType,
  /** Id of the source document to clone. */
  id: z.string().min(1),
  /** Optional field overrides merged into the copy (e.g. a new name). */
  overrides: DocumentData.optional(),
});
export type DuplicateCommand = z.infer<typeof DuplicateCommand>;

export const CreateEmbeddedCommand = z.object({
  action: z.literal("createEmbedded"),
  parentType: DocumentType,
  parentId: z.string().min(1),
  /** e.g. "Token", "AmbientLight", "Note", "ActiveEffect", "Item". */
  embeddedName: z.string().min(1),
  data: z.array(DocumentData).min(1),
});
export type CreateEmbeddedCommand = z.infer<typeof CreateEmbeddedCommand>;

export const UpdateEmbeddedCommand = z.object({
  action: z.literal("updateEmbedded"),
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  /** Each entry must carry its embedded "_id". */
  data: z.array(DocumentData.and(z.object({ _id: z.string().min(1) }))).min(1),
});
export type UpdateEmbeddedCommand = z.infer<typeof UpdateEmbeddedCommand>;

export const DeleteEmbeddedCommand = z.object({
  action: z.literal("deleteEmbedded"),
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1),
});
export type DeleteEmbeddedCommand = z.infer<typeof DeleteEmbeddedCommand>;

export const FindCommand = z.object({
  action: z.literal("find"),
  documentType: DocumentType,
  /** Optional single id; when present a single document is returned. */
  id: z.string().min(1).optional(),
  /** Shallow equality query over top-level/dot-notation fields. */
  query: z.record(z.string(), z.unknown()).optional(),
});
export type FindCommand = z.infer<typeof FindCommand>;

export const CreateQuestCommand = z.object({
  action: z.literal("createQuest"),
  /** Quest data: name, status, giver, etc. See forien-quest-log Quest model. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Optional parent quest id for subquests. */
  parentId: z.string().min(1).optional(),
});
export type CreateQuestCommand = z.infer<typeof CreateQuestCommand>;

export const UpdateQuestCommand = z.object({
  action: z.literal("updateQuest"),
  /** Quest id to update. */
  id: z.string().min(1),
  /** Partial quest data to merge. */
  data: z.record(z.string(), z.unknown()),
});
export type UpdateQuestCommand = z.infer<typeof UpdateQuestCommand>;

export const DeleteQuestCommand = z.object({
  action: z.literal("deleteQuest"),
  /** Quest id to delete. */
  id: z.string().min(1),
});
export type DeleteQuestCommand = z.infer<typeof DeleteQuestCommand>;

export const GetWorldInfoCommand = z.object({
  action: z.literal("getWorldInfo"),
});
export type GetWorldInfoCommand = z.infer<typeof GetWorldInfoCommand>;

export const UploadAssetCommand = z.object({
  action: z.literal("uploadAsset"),
  /** Storage source: local "data" or Forge "forgevtt". */
  source: z.enum(["data", "forgevtt"]).default("data"),
  /** Target directory (trailing slash optional). */
  target: z.string().min(1),
  /** File name including extension. */
  filename: z.string().min(1),
  /** File bytes, base64-encoded. */
  contentBase64: z.string().min(1),
  /** Optional MIME type hint (e.g. "image/webp"). */
  mimeType: z.string().optional(),
});
export type UploadAssetCommand = z.infer<typeof UploadAssetCommand>;

export const BrowseAssetsCommand = z.object({
  action: z.literal("browseAssets"),
  /** Storage source: local "data" or Forge "forgevtt". */
  source: z.enum(["data", "forgevtt"]).default("data"),
  /** Directory path to list. Trailing slash optional. */
  target: z.string().min(1),
  /** Optional file extension filter (e.g. [".webp", ".png"]). */
  extensions: z.array(z.string()).optional(),
});
export type BrowseAssetsCommand = z.infer<typeof BrowseAssetsCommand>;

export const BatchUploadEntry = z.object({
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  mimeType: z.string().optional(),
});
export type BatchUploadEntry = z.infer<typeof BatchUploadEntry>;

export const BatchUploadAssetsCommand = z.object({
  action: z.literal("batchUploadAssets"),
  /** Storage source: local "data" or Forge "forgevtt". */
  source: z.enum(["data", "forgevtt"]).default("data"),
  /** Target directory (trailing slash optional). */
  target: z.string().min(1),
  /** Files to upload. */
  files: z.array(BatchUploadEntry).min(1).max(50),
  /** If true, skip files whose path already exists. */
  skipExisting: z.boolean().default(false),
});
export type BatchUploadAssetsCommand = z.infer<typeof BatchUploadAssetsCommand>;

export const SearchCompendiumCommand = z.object({
  action: z.literal("searchCompendium"),
  /** Optional pack scope, defaults to "dnd5e" for compendium searches. */
  packScope: z.string().optional(),
  /** Document type to search for (e.g. "Actor", "Item"). */
  documentType: DocumentType,
  /** Search query by name (partial match). */
  nameQuery: z.string().min(1),
});
export type SearchCompendiumCommand = z.infer<typeof SearchCompendiumCommand>;

/**
 * A compendium index entry, as returned by `searchCompendium`. Shared so the
 * module (protocol-executor.ts's `FoundryDocumentApi`), the mcp-server, and
 * any standalone consumer (e.g. statblock-sync's tier matching) agree on the
 * same shape instead of each re-declaring it independently.
 */
export interface CompendiumEntry {
  uuid: string;
  pack: string;
  name: string;
  type: string;
  cr?: number;
}

export const ImportFromCompendiumCommand = z.object({
  action: z.literal("importFromCompendium"),
  /** Document type to import (e.g. "Actor", "Item"). */
  documentType: DocumentType,
  /** UUID of the compendium entry to import (e.g. "Compendium.dnd5e.actors24.Item.xyz"). */
  uuid: z.string().min(1),
  /** Optional dot-notation patch to apply to the imported document. */
  patch: DocumentData.optional(),
  /** Optional folder id to place the imported document in. */
  folderId: z.string().optional(),
});
export type ImportFromCompendiumCommand = z.infer<typeof ImportFromCompendiumCommand>;

export const ImportEmbeddedFromCompendiumEntry = z.object({
  uuid: z.string().min(1),
  /** Optional dot-notation patch applied to this entry's cloned data. */
  patch: DocumentData.optional(),
});
export type ImportEmbeddedFromCompendiumEntry = z.infer<typeof ImportEmbeddedFromCompendiumEntry>;

export const ImportEmbeddedFromCompendiumCommand = z.object({
  action: z.literal("importEmbeddedFromCompendium"),
  parentType: DocumentType,
  parentId: z.string().min(1),
  /** e.g. "Item" (spells cloned onto an actor). */
  embeddedName: z.string().min(1),
  /** Batched so a whole spell list attaches in one round-trip. */
  uuids: z.array(ImportEmbeddedFromCompendiumEntry).min(1),
});
export type ImportEmbeddedFromCompendiumCommand = z.infer<typeof ImportEmbeddedFromCompendiumCommand>;

export const GetCompendiumDocumentCommand = z.object({
  action: z.literal("getCompendiumDocument"),
  uuid: z.string().min(1),
});
export type GetCompendiumDocumentCommand = z.infer<typeof GetCompendiumDocumentCommand>;

export interface CompendiumDocumentItem {
  uuid: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
  effects?: Record<string, unknown>[];
}
export interface CompendiumDocument {
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
  items: CompendiumDocumentItem[];
}

export const Command = z.discriminatedUnion("action", [
  CreateCommand,
  UpdateCommand,
  DeleteCommand,
  DuplicateCommand,
  CreateEmbeddedCommand,
  UpdateEmbeddedCommand,
  DeleteEmbeddedCommand,
  FindCommand,
  CreateQuestCommand,
  UpdateQuestCommand,
  DeleteQuestCommand,
  GetWorldInfoCommand,
  UploadAssetCommand,
  BrowseAssetsCommand,
  BatchUploadAssetsCommand,
  SearchCompendiumCommand,
  ImportFromCompendiumCommand,
  ImportEmbeddedFromCompendiumCommand,
  GetCompendiumDocumentCommand,
]);
export type Command = z.infer<typeof Command>;

export const CommandEnvelope = z.object({
  /** Correlation id (uuid) tying a result back to its command. */
  id: z.string().min(1),
  protocolVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  /** When true the module validates construction but does not persist (§11.2). */
  dryRun: z.boolean().default(false),
  /** Auth token; checked against the module's configured token. */
  token: z.string().optional(),
  command: Command,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

/** Stable, machine-readable error codes for the reliability layer (§11). */
export const ErrorCode = z.enum([
  "VALIDATION",
  "AUTH",
  "NOT_FOUND",
  "CONFLICT",
  "TIMEOUT",
  "READBACK_MISMATCH",
  "UNSUPPORTED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const CommandError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
});
export type CommandError = z.infer<typeof CommandError>;

export const CommandResult = z.discriminatedUnion("ok", [
  z.object({
    id: z.string().min(1),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    error: CommandError,
  }),
]);
export type CommandResult = z.infer<typeof CommandResult>;

/** Helpers so both ends construct results identically. */
export function ok(id: string, data: unknown): CommandResult {
  return { id, ok: true, data };
}

export function err(
  id: string,
  code: ErrorCode,
  message: string,
  details?: unknown,
): CommandResult {
  return { id, ok: false, error: { code, message, details } };
}

/** Context for the envelope guards: who is executing and the expected token. */
export interface GuardContext {
  isGM: boolean;
  expectedToken?: string;
}

/**
 * Protocol-level guards run identically by the module executor and the mock:
 * protocol version, auth token, then GM privilege. Returns a structured error
 * to reject with, or null when the envelope may proceed.
 */
export function checkEnvelopeGuards(
  envelope: CommandEnvelope,
  ctx: GuardContext,
): CommandError | null {
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return {
      code: "VALIDATION",
      message: "protocol version mismatch",
      details: { expected: PROTOCOL_VERSION, received: envelope.protocolVersion },
    };
  }
  if (ctx.expectedToken !== undefined && envelope.token !== ctx.expectedToken) {
    return { code: "AUTH", message: "invalid or missing token" };
  }
  if (!ctx.isGM) {
    return { code: "AUTH", message: "GM privileges required" };
  }
  return null;
}
