/**
 * Adapts the in-memory {@link MockFoundry} into the module's
 * {@link FoundryDocumentApi}, so the module's executeCommand logic can be tested
 * end-to-end against the mock (the brief: "test the logic against mock-foundry,
 * not a real Foundry"). The mock is constructed with isGM=true and no token so
 * its own guards are no-ops; the module executor's guards are what we test.
 */

import {
  type Command,
  type DocumentType,
  PROTOCOL_VERSION,
  type CompendiumDocument,
} from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import {
  CommandExecutionError,
  type BatchUploadAssetsParams,
  type DocData,
  type ExecuteOptions,
  type FindSelector,
  type FoundryDocumentApi,
  type WorldInfo,
  type CompendiumEntry,
} from "../../packages/foundry-module/src/protocol-executor.js";

let seq = 0;

export function mockFoundryApi(mock: MockFoundry): FoundryDocumentApi {
  async function run(command: Command, opts: ExecuteOptions): Promise<unknown> {
    const res = await mock.execute({
      id: `api-${seq++}`,
      protocolVersion: PROTOCOL_VERSION,
      dryRun: opts.dryRun,
      command,
    });
    if (!res.ok) {
      throw new CommandExecutionError(res.error.code, res.error.message, res.error.details);
    }
    return res.data;
  }

  return {
    async create(type, data, opts) {
      return (await run(
        { action: "create", documentType: type, data, keepId: opts.keepId },
        opts,
      )) as DocData;
    },
    async update(type, id, diff, opts) {
      return (await run(
        { action: "update", documentType: type, id, data: diff },
        opts,
      )) as DocData;
    },
    async remove(type, id, opts) {
      await run({ action: "delete", documentType: type, id }, opts);
    },
    async duplicate(type, id, overrides, opts) {
      return (await run(
        { action: "duplicate", documentType: type, id, overrides },
        opts,
      )) as DocData;
    },
    async createEmbedded(parentType, parentId, embeddedName, data, opts) {
      return (await run(
        { action: "createEmbedded", parentType, parentId, embeddedName, data },
        opts,
      )) as DocData[];
    },
    async updateEmbedded(parentType, parentId, embeddedName, data, opts) {
      return (await run(
        {
          action: "updateEmbedded",
          parentType,
          parentId,
          embeddedName,
          data: data as (DocData & { _id: string })[],
        },
        opts,
      )) as DocData[];
    },
    async deleteEmbedded(parentType, parentId, embeddedName, ids, opts) {
      await run(
        { action: "deleteEmbedded", parentType, parentId, embeddedName, ids },
        opts,
      );
    },
    async find(type: DocumentType, selector: FindSelector) {
      return (await run(
        { action: "find", documentType: type, id: selector.id, query: selector.query },
        { dryRun: false },
      )) as DocData | DocData[];
    },
    async getWorldInfo() {
      return (await run({ action: "getWorldInfo" }, { dryRun: false })) as WorldInfo;
    },
    async uploadAsset(params, opts) {
      return (await run({ action: "uploadAsset", ...params }, opts)) as { path: string };
    },
    async browseAssets(params, opts) {
      return (await run(
        { action: "browseAssets", source: params.source, target: params.target, extensions: params.extensions },
        opts,
      )) as { dirs: string[]; files: string[]; target: string };
    },
    async batchUploadAssets(params: BatchUploadAssetsParams, opts) {
      return (await run(
        {
          action: "batchUploadAssets",
          source: params.source,
          target: params.target,
          files: params.files,
          skipExisting: params.skipExisting ?? false,
        },
        opts,
      )) as Array<{ filename: string; path: string; skipped?: boolean }>;
    },
    async createQuest(data, parentId, opts) {
      return (await run({ action: "createQuest", data, parentId }, opts)) as DocData;
    },
    async updateQuest(id, data, opts) {
      return (await run({ action: "updateQuest", id, data }, opts)) as DocData;
    },
    async deleteQuest(id, opts) {
      await run({ action: "deleteQuest", id }, opts);
    },
    async searchCompendium(packScope, documentType, nameQuery) {
      return (await run(
        { action: "searchCompendium", packScope, documentType, nameQuery },
        { dryRun: false },
      )) as CompendiumEntry[];
    },
    async importFromCompendium(documentType, uuid, patch, folderId, opts) {
      return (await run(
        { action: "importFromCompendium", documentType, uuid, patch, folderId },
        opts,
      )) as DocData;
    },
    async importEmbeddedFromCompendium(parentType, parentId, embeddedName, uuids, opts) {
      return (await run(
        { action: "importEmbeddedFromCompendium", parentType, parentId, embeddedName, uuids },
        opts,
      )) as DocData[];
    },
    async getCompendiumDocument(uuid) {
      return (await run(
        { action: "getCompendiumDocument", uuid },
        { dryRun: false },
      )) as CompendiumDocument;
    },
  } satisfies FoundryDocumentApi;
}

/** Alias for mockFoundryApi; used in tests. */
export const toApi = mockFoundryApi;
