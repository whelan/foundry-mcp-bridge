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
import { DocumentType, buildScene } from "@foundry-mcp-bridge/shared";
import type { RelayTransport } from "./relay-transport.js";
import {
  createDocumentReliable,
  updateDocumentReliable,
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
  return createDocumentReliable(transport, { documentType: "Scene", data }, opts);
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
