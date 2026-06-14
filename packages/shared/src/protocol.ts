import { z } from "zod";

/**
 * Wire protocol between the MCP server and the Foundry module.
 *
 * The MCP server sends a `Command`; the module executes it against Foundry's
 * client-side document API and replies with a `CommandResult`. Keeping this
 * contract in `shared` means server and module can never drift apart.
 */

/** World document types reachable via `CONFIG[type].documentClass.create()`. */
export const WorldDocumentType = z.enum([
  "Actor",
  "Item",
  "Scene",
  "JournalEntry",
  "RollTable",
  "Playlist",
  "Macro",
  "Cards",
  "Folder",
  "Combat",
  "ChatMessage",
]);
export type WorldDocumentType = z.infer<typeof WorldDocumentType>;

/** Embedded document types reachable via `parent.createEmbeddedDocuments(type, ...)`. */
export const EmbeddedDocumentType = z.enum([
  "Token",
  "AmbientLight",
  "AmbientSound",
  "Note",
  "Wall",
  "Tile",
  "Drawing",
  "Region",
  "TableResult",
  "PlaylistSound",
  "JournalEntryPage",
  "ActiveEffect",
  "Item",
  "Combatant",
]);
export type EmbeddedDocumentType = z.infer<typeof EmbeddedDocumentType>;

/** Arbitrary Foundry document data — validated by Foundry's own schema on write. */
const DocumentData = z.record(z.string(), z.unknown());

export const CreateDocumentCommand = z.object({
  type: z.literal("create_document"),
  documentType: WorldDocumentType,
  data: DocumentData,
});

export const UpdateDocumentCommand = z.object({
  type: z.literal("update_document"),
  documentType: WorldDocumentType,
  /** Resolve target by id or by exact name. */
  id: z.string().optional(),
  name: z.string().optional(),
  /** Partial diff — only the fields to change. */
  changes: DocumentData,
});

export const DeleteDocumentCommand = z.object({
  type: z.literal("delete_document"),
  documentType: WorldDocumentType,
  id: z.string().optional(),
  name: z.string().optional(),
});

export const CreateEmbeddedCommand = z.object({
  type: z.literal("create_embedded"),
  parentType: WorldDocumentType,
  parentId: z.string(),
  embeddedType: EmbeddedDocumentType,
  data: z.array(DocumentData),
});

export const FindDocumentCommand = z.object({
  type: z.literal("find_document"),
  documentType: WorldDocumentType,
  name: z.string(),
});

export const Command = z.discriminatedUnion("type", [
  CreateDocumentCommand,
  UpdateDocumentCommand,
  DeleteDocumentCommand,
  CreateEmbeddedCommand,
  FindDocumentCommand,
]);
export type Command = z.infer<typeof Command>;

/** Envelope adding a correlation id so server and module can match request↔reply. */
export const CommandEnvelope = z.object({
  requestId: z.string(),
  command: Command,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

export const CommandResult = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  /** Document id(s) affected, when applicable. */
  ids: z.array(z.string()).optional(),
  /** Read-back of the resulting document for verification. */
  document: z.unknown().optional(),
  /** Failure detail (pálidelighedslaget surfaces this back to the AI). */
  stage: z.string().optional(),
  reason: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;
