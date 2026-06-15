/**
 * Tool definitions. Framework-agnostic: each tool exposes a zod input shape and
 * a `run` that drives the reliability pipeline against a {@link RelayTransport}.
 * server.ts registers these with the MCP SDK; tests call `run` directly against
 * the mock-foundry-backed transport.
 *
 * Order matches live-api-plan §7: create_document first, then create_scene
 * (reusing the shared scene builders) and update_document.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DocumentType, buildScene, buildSceneVerify } from "@foundry-mcp-bridge/shared";
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
  type PipelineOptions,
  type ToolOutcome,
} from "./reliability.js";

const documentData = z.record(z.string(), z.unknown());

// --- create_document --------------------------------------------------------

export const CreateDocumentShape = {
  documentType: DocumentType,
  data: documentData,
};
const CreateDocument = z.object(CreateDocumentShape);
export type CreateDocumentArgs = z.infer<typeof CreateDocument>;

export function runCreateDocument(
  transport: RelayTransport,
  args: CreateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return createDocumentReliable(transport, args, opts);
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
};
const CreateScene = z.object(CreateSceneShape);
export type CreateSceneArgs = z.infer<typeof CreateScene>;

export function runCreateScene(
  transport: RelayTransport,
  args: CreateSceneArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const data = buildScene(args);
  const verifyData = buildSceneVerify(args);
  return createDocumentReliable(transport, { documentType: "Scene", data, verifyData }, opts);
}

// --- update_document --------------------------------------------------------

export const UpdateDocumentShape = {
  documentType: DocumentType,
  id: z.string().min(1),
  data: documentData,
};
const UpdateDocument = z.object(UpdateDocumentShape);
export type UpdateDocumentArgs = z.infer<typeof UpdateDocument>;

export function runUpdateDocument(
  transport: RelayTransport,
  args: UpdateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return updateDocumentReliable(transport, args, opts);
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
};
const DuplicateDocument = z.object(DuplicateDocumentShape);
export type DuplicateDocumentArgs = z.infer<typeof DuplicateDocument>;

export function runDuplicateDocument(
  transport: RelayTransport,
  args: DuplicateDocumentArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return duplicateDocumentReliable(transport, args, opts);
}

// --- find_documents ---------------------------------------------------------

export const FindDocumentsShape = {
  documentType: DocumentType,
  id: z.string().min(1).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
};
const FindDocuments = z.object(FindDocumentsShape);
export type FindDocumentsArgs = z.infer<typeof FindDocuments>;

export async function runFindDocuments(
  transport: RelayTransport,
  args: FindDocumentsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = ["find"];
  const envelope = {
    id: randomUUID(),
    protocolVersion: "1" as const,
    dryRun: false,
    token: opts.token,
    command: { action: "find" as const, documentType: args.documentType, id: args.id, query: args.query },
  };
  try {
    const result = await transport.request(envelope, { timeoutMs: opts.timeoutMs });
    if (!result.ok) {
      return { ok: false, error: result.error, steps };
    }
    return { ok: true, data: result.data, steps };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: e instanceof Error && "code" in e ? (e as any).code : "INTERNAL",
        message: (e as Error).message,
      },
      steps,
    };
  }
}

// --- get_world_info ---------------------------------------------------------

export const GetWorldInfoShape = {};
const GetWorldInfo = z.object(GetWorldInfoShape);
export type GetWorldInfoArgs = z.infer<typeof GetWorldInfo>;

export async function runGetWorldInfo(
  transport: RelayTransport,
  _args: GetWorldInfoArgs = {},
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  const steps: string[] = ["get-world-info"];
  const envelope = {
    id: randomUUID(),
    protocolVersion: "1" as const,
    dryRun: false,
    token: opts.token,
    command: { action: "getWorldInfo" as const },
  };
  try {
    const result = await transport.request(envelope, { timeoutMs: opts.timeoutMs });
    if (!result.ok) {
      return { ok: false, error: result.error, steps };
    }
    return { ok: true, data: result.data, steps };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: e instanceof Error && "code" in e ? (e as any).code : "INTERNAL",
        message: (e as Error).message,
      },
      steps,
    };
  }
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

// --- create_embedded --------------------------------------------------------

export const CreateEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  data: z.array(documentData).min(1),
};
const CreateEmbedded = z.object(CreateEmbeddedShape);
export type CreateEmbeddedArgs = z.infer<typeof CreateEmbedded>;

export function runCreateEmbedded(
  transport: RelayTransport,
  args: CreateEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return createEmbeddedReliable(transport, args, opts);
}

// --- update_embedded --------------------------------------------------------

export const UpdateEmbeddedShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  data: z.array(documentData.and(z.object({ _id: z.string().min(1) }))).min(1),
};
const UpdateEmbedded = z.object(UpdateEmbeddedShape);
export type UpdateEmbeddedArgs = z.infer<typeof UpdateEmbedded>;

export function runUpdateEmbedded(
  transport: RelayTransport,
  args: UpdateEmbeddedArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return updateEmbeddedReliable(transport, args, opts);
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
