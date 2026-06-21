/**
 * MCP server wiring. Registers the tools (live-api-plan §7) and routes each call
 * through the reliability pipeline. The pipeline/tool logic is what tests cover;
 * this file is the thin MCP-SDK adapter.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RelayTransport } from "./relay-transport.js";
import type { PipelineOptions } from "./reliability.js";
import type { ToolOutcome } from "./reliability.js";
import {
  CreateDocumentShape,
  CreateSceneShape,
  UpdateDocumentShape,
  DeleteDocumentShape,
  DuplicateDocumentShape,
  FindDocumentsShape,
  GetWorldInfoShape,
  UploadAssetShape,
  BrowseAssetsShape,
  BatchUploadAssetsShape,
  CreateEmbeddedShape,
  UpdateEmbeddedShape,
  DeleteEmbeddedShape,
  CreateQuestShape,
  UpdateQuestShape,
  DeleteQuestShape,
  runCreateDocument,
  runCreateScene,
  runUpdateDocument,
  runDeleteDocument,
  runDuplicateDocument,
  runFindDocuments,
  runGetWorldInfo,
  runUploadAsset,
  runBrowseAssets,
  runBatchUploadAssets,
  runCreateEmbedded,
  runUpdateEmbedded,
  runDeleteEmbedded,
  runCreateQuest,
  runUpdateQuest,
  runDeleteQuest,
} from "./tools.js";
import {
  ForgeBrowseAssetsShape,
  ForgeUploadAssetShape,
  ForgeBatchUploadAssetsShape,
  ForgeCreateFolderShape,
  runForgeBrowseAssets,
  runForgeUploadAsset,
  runForgeBatchUploadAssets,
  runForgeCreateFolder,
  type ForgeClientRef,
} from "./forge-tools.js";

function toCallResult(outcome: ToolOutcome) {
  // Compact (no pretty-print): the result is consumed by an LLM, so indentation
  // whitespace is pure token cost with no benefit.
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
    isError: !outcome.ok,
  };
}

export function buildServer(
  transport: RelayTransport,
  opts: PipelineOptions = {},
  forge: ForgeClientRef = null,
): McpServer {
  const server = new McpServer({ name: "foundry-mcp-bridge", version: "0.1.0" });
  const log = opts.log;

  // Register a tool and wrap its handler with a trace of entry + outcome+steps.
  // Generic over the input shape so a mismatched shape/handler pairing fails tsc.
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (
      transport: RelayTransport,
      args: z.infer<z.ZodObject<S>>,
      opts: PipelineOptions,
    ) => Promise<ToolOutcome>,
  ): void {
    // `run` is tied to S, so a mismatched shape/handler pairing fails tsc here.
    const handler = async (args: z.infer<z.ZodObject<S>>) => {
      log?.(`▶ ${name}`);
      const out = await run(transport, args, opts);
      log?.(
        out.ok
          ? `◀ ${name} ok [${out.steps.join(" > ")}]`
          : `◀ ${name} ERROR ${out.error.code}: ${out.error.message} [${out.steps.join(" > ")}]`,
      );
      return toCallResult(out);
    };
    // The SDK can't infer a concrete callback type from a generic shape, so cast
    // only at this boundary (the pairing safety above is unaffected).
    server.registerTool(
      name,
      { description, inputSchema },
      handler as unknown as Parameters<typeof server.registerTool>[2],
    );
  }

  // Forge Phase 2 tools bypass the relay and call the Forge REST API directly,
  // so they take the (possibly null) Forge client instead of the transport.
  function registerForge<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (
      forge: ForgeClientRef,
      args: z.infer<z.ZodObject<S>>,
      opts: PipelineOptions,
    ) => Promise<ToolOutcome>,
  ): void {
    const handler = async (args: z.infer<z.ZodObject<S>>) => {
      log?.(`▶ ${name}`);
      const out = await run(forge, args, opts);
      log?.(
        out.ok
          ? `◀ ${name} ok [${out.steps.join(" > ")}]`
          : `◀ ${name} ERROR ${out.error.code}: ${out.error.message} [${out.steps.join(" > ")}]`,
      );
      return toCallResult(out);
    };
    server.registerTool(
      name,
      { description, inputSchema },
      handler as unknown as Parameters<typeof server.registerTool>[2],
    );
  }

  register(
    "create_document",
    "Create a Foundry document of the given type. Runs the full reliability pipeline (validate, dry-run, write, read-back verify, rollback on mismatch).",
    CreateDocumentShape,
    runCreateDocument,
  );
  register(
    "create_scene",
    "Create a V14 Scene from high-level parameters (built with the shared scene builders), then run the reliability pipeline.",
    CreateSceneShape,
    runCreateScene,
  );
  register(
    "update_document",
    "Partially update a Foundry document by id (Foundry dot-notation supported). Read-back verifies the changed fields and restores on mismatch.",
    UpdateDocumentShape,
    runUpdateDocument,
  );
  register(
    "delete_document",
    "Delete a Foundry document by id. Runs dry-run and write; no rollback possible.",
    DeleteDocumentShape,
    runDeleteDocument,
  );
  register(
    "duplicate_document",
    "Clone an existing Foundry document by id, with optional field overrides (e.g. a new name). Runs the full reliability pipeline; rolls back the copy on read-back failure.",
    DuplicateDocumentShape,
    runDuplicateDocument,
  );
  register(
    "find_documents",
    "Query and read Foundry documents. Pass id for a single document, or query for shallow field matching. Pass fields (e.g. [\"_id\",\"_stats.modifiedTime\"]) to project each result to just those dot-paths — strongly recommended for bulk reads to avoid returning whole documents. Returns document(s) for inspection.",
    FindDocumentsShape,
    runFindDocuments,
  );
  register(
    "get_world_info",
    "Read world metadata for safe importing: Foundry version, game system (id/version), world id/title, and the list of folders (id/name/type) for resolving folder placement. Read-only.",
    GetWorldInfoShape,
    runGetWorldInfo,
  );
  register(
    "upload_asset",
    "Upload a file (base64) to Foundry storage via FilePicker — e.g. a scene background or token image. Returns the stored path to reference on a document. source 'data' (local) or 'forgevtt' (The Forge).",
    UploadAssetShape,
    runUploadAsset,
  );
  register(
    "browse_assets",
    "List files and sub-directories in a Foundry asset directory. Use source=\"forgevtt\" when the world is hosted on The Forge. Returns { dirs, files, target }.",
    BrowseAssetsShape,
    runBrowseAssets,
  );
  register(
    "batch_upload_assets",
    "Upload multiple asset files to Foundry storage in one call. Use source=\"forgevtt\" on The Forge. Set skipExisting=true to skip files already present. Returns array of { filename, path, skipped? }. Max 50 files per call.",
    BatchUploadAssetsShape,
    runBatchUploadAssets,
  );
  register(
    "create_embedded",
    "Create embedded documents (e.g., tokens, items, effects) within a parent. Runs the full reliability pipeline with read-back of the parent.",
    CreateEmbeddedShape,
    runCreateEmbedded,
  );
  register(
    "update_embedded",
    "Update embedded documents within a parent. Each entry must carry its _id. Read-back verifies against parent; restores parent on mismatch.",
    UpdateEmbeddedShape,
    runUpdateEmbedded,
  );
  register(
    "delete_embedded",
    "Delete embedded documents by id. Runs dry-run and write.",
    DeleteEmbeddedShape,
    runDeleteEmbedded,
  );
  register(
    "create_quest",
    "Create a quest via Forien's Quest Log (requires the module to be enabled). Runs dry-run and write; no content read-back (the module normalizes fields and quests aren't queryable) — success means the write returned an _id.",
    CreateQuestShape,
    runCreateQuest,
  );
  register(
    "update_quest",
    "Update a quest by id (partial). Runs dry-run and write; no content read-back (the module normalizes fields and quests aren't queryable).",
    UpdateQuestShape,
    runUpdateQuest,
  );
  register(
    "delete_quest",
    "Delete a quest by id. Runs dry-run and write.",
    DeleteQuestShape,
    runDeleteQuest,
  );

  // --- Forge Phase 2: direct REST asset tools (no relay) ---------------------
  registerForge(
    "forge_browse_assets",
    "List files and sub-directories in The Forge asset bucket via the direct Forge REST API (no running world needed). Requires FORGE_USER_ID + FORGE_API_KEY. Returns { files, dirs }.",
    ForgeBrowseAssetsShape,
    runForgeBrowseAssets,
  );
  registerForge(
    "forge_upload_asset",
    "Upload a base64 file straight to The Forge bucket via the direct Forge REST API (no running world needed). Requires FORGE_USER_ID + FORGE_API_KEY. Returns { path }.",
    ForgeUploadAssetShape,
    runForgeUploadAsset,
  );
  registerForge(
    "forge_batch_upload_assets",
    "Upload multiple base64 files straight to The Forge bucket via the direct Forge REST API (no running world needed). Requires FORGE_USER_ID + FORGE_API_KEY. Set skipExisting=true to skip files already present (matched by basename). Returns array of { filename, path, skipped? }. Max 50 files per call.",
    ForgeBatchUploadAssetsShape,
    runForgeBatchUploadAssets,
  );
  registerForge(
    "forge_create_folder",
    "Create a folder in The Forge asset bucket via the direct Forge REST API. Requires FORGE_USER_ID + FORGE_API_KEY. Returns { success }.",
    ForgeCreateFolderShape,
    runForgeCreateFolder,
  );

  return server;
}
