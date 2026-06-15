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
};

/** Arbitrary Foundry document data — validated structurally, not field-by-field. */
const DocumentData = z.record(z.string(), z.unknown());

export const CreateCommand = z.object({
  action: z.literal("create"),
  documentType: DocumentType,
  data: DocumentData,
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

export const Command = z.discriminatedUnion("action", [
  CreateCommand,
  UpdateCommand,
  DeleteCommand,
  CreateEmbeddedCommand,
  UpdateEmbeddedCommand,
  DeleteEmbeddedCommand,
  FindCommand,
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
