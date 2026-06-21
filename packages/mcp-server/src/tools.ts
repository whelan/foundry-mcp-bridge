/**
 * Tool definitions. Framework-agnostic: each tool exposes a zod input shape and
 * a `run` that drives the reliability pipeline against a {@link RelayTransport}.
 * server.ts registers these with the MCP SDK; tests call `run` directly against
 * the mock-foundry-backed transport.
 *
 * Order matches live-api-plan §7: create_document first, then create_scene
 * (reusing the shared scene builders) and update_document.
 */

import { z } from "zod";
import {
  DocumentType,
  buildScene,
  buildSceneVerify,
  getByPath,
  expandObject,
} from "@foundry-mcp-bridge/shared";
import type { RelayTransport } from "./relay-transport.js";
import {
  createDocumentReliable,
  updateDocumentReliable,
  deleteDocumentReliable,
  duplicateDocumentReliable,
  createEmbeddedReliable,
  updateEmbeddedReliable,
  deleteEmbeddedReliable,
  createQuestReliable,
  updateQuestReliable,
  deleteQuestReliable,
  uploadAssetReliable,
  browseAssetsReliable,
  batchUploadAssetsReliable,
  runRead,
  type PipelineOptions,
  type ToolOutcome,
} from "./reliability.js";

const documentData = z.record(z.string(), z.unknown());

/**
 * Optional dot-path projection for a tool's result echo. Mutating tools echo the
 * written document back; for bulk work (imports) that's the dominant token cost
 * and callers usually only need a key or two. Pass e.g. ["_id"] or
 * ["_id","_stats.modifiedTime"] to slim the echo. Omit for the full document.
 */
const fieldsParam = z.array(z.string().min(1)).min(1).optional();

// --- create_document --------------------------------------------------------

export const CreateDocumentShape = {
  documentType: DocumentType,
  data: documentData,
  keepId: z.boolean().optional(),
  fields: fieldsParam,
};
const CreateDocument = z.object(CreateDocumentShape);
export type CreateDocumentArgs = z.infer<typeof CreateDocument>;

export async function runCreateDocument(
  transport: RelayTransport,
  args: CreateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return project(await createDocumentReliable(transport, args, opts), args.fields);
}

// --- create_scene -----------------------------------------------------------

export const CreateSceneShape = {
  name: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  gridSize: z.number().int().positive().optional(),
  gridType: z.number().int().min(0).max(5).optional(),
  gridDistance: z.number().positive().optional(),
  gridUnits: z.string().optional(),
  background: z.string().optional(),
  backgroundColor: z.string().optional(),
  padding: z.number().min(0).optional(),
  fields: fieldsParam,
};
const CreateScene = z.object(CreateSceneShape);
export type CreateSceneArgs = z.infer<typeof CreateScene>;

export async function runCreateScene(
  transport: RelayTransport,
  args: CreateSceneArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const data = buildScene(args);
  const verifyData = buildSceneVerify(args);
  const outcome = await createDocumentReliable(
    transport,
    { documentType: "Scene", data, verifyData },
    opts,
  );
  return project(outcome, args.fields);
}

// --- update_document --------------------------------------------------------

export const UpdateDocumentShape = {
  documentType: DocumentType,
  id: z.string().min(1),
  data: documentData,
  fields: fieldsParam,
};
const UpdateDocument = z.object(UpdateDocumentShape);
export type UpdateDocumentArgs = z.infer<typeof UpdateDocument>;

export async function runUpdateDocument(
  transport: RelayTransport,
  args: UpdateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return project(await updateDocumentReliable(transport, args, opts), args.fields);
}

// --- delete_document --------------------------------------------------------

export const DeleteDocumentShape = {
  documentType: DocumentType,
  id: z.string().min(1),
};
const DeleteDocument = z.object(DeleteDocumentShape);
export type DeleteDocumentArgs = z.infer<typeof DeleteDocument>;

export function runDeleteDocument(
  transport: RelayTransport,
  args: DeleteDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return deleteDocumentReliable(transport, args, opts);
}

// --- duplicate_document -----------------------------------------------------

export const DuplicateDocumentShape = {
  documentType: DocumentType,
  id: z.string().min(1),
  overrides: documentData.optional(),
  fields: fieldsParam,
};
const DuplicateDocument = z.object(DuplicateDocumentShape);
export type DuplicateDocumentArgs = z.infer<typeof DuplicateDocument>;

export async function runDuplicateDocument(
  transport: RelayTransport,
  args: DuplicateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return project(await duplicateDocumentReliable(transport, args, opts), args.fields);
}

// --- find_documents ---------------------------------------------------------

export const FindDocumentsShape = {
  documentType: DocumentType,
  id: z.string().min(1).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  /**
   * Project each result to only these dot-notation paths (e.g.
   * ["_id", "_stats.modifiedTime"]). Strongly recommended for bulk reads — a full
   * document (scene walls/lights/tokens, actor system data) is large; most callers
   * only need a few fields. Omit to return whole documents.
   */
  fields: z.array(z.string().min(1)).min(1).optional(),
};
const FindDocuments = z.object(FindDocumentsShape);
export type FindDocumentsArgs = z.infer<typeof FindDocuments>;

export async function runFindDocuments(
  transport: RelayTransport,
  args: FindDocumentsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const outcome = await runRead(
    transport,
    { action: "find", documentType: args.documentType, id: args.id, query: args.query },
    "find",
    opts,
  );
  return project(outcome, args.fields);
}

/**
 * Project a successful tool result to only the requested dot-paths, so a large
 * document echo (a created Scene, an updated Actor) never reaches the model's
 * context. The relay already returned the full doc(s); trimming here is what saves
 * tokens (the wire/Node hop isn't token-billed, the tool result is). A no-op when
 * the outcome failed or no fields were requested (full echo, back-compat).
 */
function project(outcome: ToolOutcome, fields?: string[]): ToolOutcome {
  if (!outcome.ok || !fields) return outcome;
  return { ...outcome, data: projectResult(outcome.data, fields) };
}

/** Apply a dot-path projection to a result (single doc or array of docs). */
function projectResult(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) return data.map((d) => projectDoc(d, fields));
  return projectDoc(data, fields);
}

function projectDoc(doc: unknown, fields: string[]): unknown {
  if (doc === null || typeof doc !== "object") return doc;
  const flat: Record<string, unknown> = {};
  for (const path of fields) {
    const value = getByPath(doc, path);
    if (value !== undefined) flat[path] = value;
  }
  return expandObject(flat);
}

// --- get_world_info ---------------------------------------------------------

export const GetWorldInfoShape = {};
const GetWorldInfo = z.object(GetWorldInfoShape);
export type GetWorldInfoArgs = z.infer<typeof GetWorldInfo>;

export function runGetWorldInfo(
  transport: RelayTransport,
  _args: GetWorldInfoArgs = {},
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runRead(transport, { action: "getWorldInfo" }, "get-world-info", opts);
}

// --- upload_asset -----------------------------------------------------------

export const UploadAssetShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  mimeType: z.string().optional(),
};
const UploadAsset = z.object(UploadAssetShape);
export type UploadAssetArgs = z.infer<typeof UploadAsset>;

export function runUploadAsset(
  transport: RelayTransport,
  args: UploadAssetArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return uploadAssetReliable(transport, args, opts);
}

// --- browse_assets ----------------------------------------------------------

export const BrowseAssetsShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  extensions: z.array(z.string()).optional(),
};
const BrowseAssets = z.object(BrowseAssetsShape);
export type BrowseAssetsArgs = z.infer<typeof BrowseAssets>;

export function runBrowseAssets(
  transport: RelayTransport,
  args: BrowseAssetsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return browseAssetsReliable(transport, args, opts);
}

// --- batch_upload_assets ----------------------------------------------------

export const BatchUploadAssetsShape = {
  source: z.enum(["data", "forgevtt"]).default("data"),
  target: z.string().min(1),
  files: z.array(
    z.object({
      filename: z.string().min(1),
      contentBase64: z.string().min(1),
      mimeType: z.string().optional(),
    }),
  ).min(1).max(50),
  skipExisting: z.boolean().optional(),
};
const BatchUploadAssets = z.object(BatchUploadAssetsShape);
export type BatchUploadAssetsArgs = z.infer<typeof BatchUploadAssets>;

export function runBatchUploadAssets(
  transport: RelayTransport,
  args: BatchUploadAssetsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return batchUploadAssetsReliable(transport, args, opts);
}

// --- create_embedded --------------------------------------------------------

export const CreateEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  data: z.array(documentData).min(1),
  fields: fieldsParam,
};
const CreateEmbedded = z.object(CreateEmbeddedShape);
export type CreateEmbeddedArgs = z.infer<typeof CreateEmbedded>;

export async function runCreateEmbedded(
  transport: RelayTransport,
  args: CreateEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return project(await createEmbeddedReliable(transport, args, opts), args.fields);
}

// --- update_embedded --------------------------------------------------------

export const UpdateEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  data: z.array(documentData.and(z.object({ _id: z.string().min(1) }))).min(1),
  fields: fieldsParam,
};
const UpdateEmbedded = z.object(UpdateEmbeddedShape);
export type UpdateEmbeddedArgs = z.infer<typeof UpdateEmbedded>;

export async function runUpdateEmbedded(
  transport: RelayTransport,
  args: UpdateEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return project(await updateEmbeddedReliable(transport, args, opts), args.fields);
}

// --- delete_embedded --------------------------------------------------------

export const DeleteEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1),
};
const DeleteEmbedded = z.object(DeleteEmbeddedShape);
export type DeleteEmbeddedArgs = z.infer<typeof DeleteEmbedded>;

export function runDeleteEmbedded(
  transport: RelayTransport,
  args: DeleteEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return deleteEmbeddedReliable(transport, args, opts);
}

// --- create_quest -----------------------------------------------------------

export const CreateQuestShape = {
  data: z.record(z.string(), z.unknown()).optional(),
  parentId: z.string().min(1).optional(),
};
const CreateQuest = z.object(CreateQuestShape);
export type CreateQuestArgs = z.infer<typeof CreateQuest>;

export function runCreateQuest(
  transport: RelayTransport,
  args: CreateQuestArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return createQuestReliable(transport, args, opts);
}

// --- update_quest -----------------------------------------------------------

export const UpdateQuestShape = {
  id: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
};
const UpdateQuest = z.object(UpdateQuestShape);
export type UpdateQuestArgs = z.infer<typeof UpdateQuest>;

export function runUpdateQuest(
  transport: RelayTransport,
  args: UpdateQuestArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return updateQuestReliable(transport, args, opts);
}

// --- delete_quest -----------------------------------------------------------

export const DeleteQuestShape = {
  id: z.string().min(1),
};
const DeleteQuest = z.object(DeleteQuestShape);
export type DeleteQuestArgs = z.infer<typeof DeleteQuest>;

export function runDeleteQuest(
  transport: RelayTransport,
  args: DeleteQuestArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return deleteQuestReliable(transport, args, opts);
}
