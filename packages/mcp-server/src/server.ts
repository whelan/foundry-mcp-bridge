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
  runCreateEmbedded,
  runUpdateEmbedded,
  runDeleteEmbedded,
  runCreateQuest,
  runUpdateQuest,
  runDeleteQuest,
} from "./tools.js";

function toCallResult(outcome: ToolOutcome) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outcome, null, 2) }],
    isError: !outcome.ok,
  };
}

type ToolRun = (
  transport: RelayTransport,
  args: never,
  opts: PipelineOptions,
) => Promise<ToolOutcome>;

export function buildServer(transport: RelayTransport, opts: PipelineOptions = {}): McpServer {
  const server = new McpServer({ name: "foundry-mcp-bridge", version: "0.1.0" });
  const log = opts.log;

  // Register a tool and wrap its handler with a trace of entry + outcome+steps.
  function register(
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    run: ToolRun,
  ): void {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      log?.(`▶ ${name}`);
      const out = await run(transport, args as never, opts);
      log?.(
        out.ok
          ? `◀ ${name} ok [${out.steps.join(" > ")}]`
          : `◀ ${name} ERROR ${out.error.code}: ${out.error.message} [${out.steps.join(" > ")}]`,
      );
      return toCallResult(out);
    });
  }

  register(
    "create_document",
    "Create a Foundry document of the given type. Runs the full reliability pipeline (validate, dry-run, write, read-back verify, rollback on mismatch).",
    CreateDocumentShape,
    runCreateDocument as ToolRun,
  );
  register(
    "create_scene",
    "Create a V14 Scene from high-level parameters (built with the shared scene builders), then run the reliability pipeline.",
    CreateSceneShape,
    runCreateScene as ToolRun,
  );
  register(
    "update_document",
    "Partially update a Foundry document by id (Foundry dot-notation supported). Read-back verifies the changed fields and restores on mismatch.",
    UpdateDocumentShape,
    runUpdateDocument as ToolRun,
  );
  register(
    "delete_document",
    "Delete a Foundry document by id. Runs dry-run and write; no rollback possible.",
    DeleteDocumentShape,
    runDeleteDocument as ToolRun,
  );
  register(
    "duplicate_document",
    "Clone an existing Foundry document by id, with optional field overrides (e.g. a new name). Runs the full reliability pipeline; rolls back the copy on read-back failure.",
    DuplicateDocumentShape,
    runDuplicateDocument as ToolRun,
  );
  register(
    "find_documents",
    "Query and read Foundry documents. Pass id for a single document, or query for shallow field matching. Returns document(s) for inspection.",
    FindDocumentsShape,
    runFindDocuments as ToolRun,
  );
  register(
    "get_world_info",
    "Read world metadata for safe importing: Foundry version, game system (id/version), world id/title, and the list of folders (id/name/type) for resolving folder placement. Read-only.",
    GetWorldInfoShape,
    runGetWorldInfo as ToolRun,
  );
  register(
    "upload_asset",
    "Upload a file (base64) to Foundry storage via FilePicker — e.g. a scene background or token image. Returns the stored path to reference on a document. source 'data' (local) or 'forgevtt' (The Forge).",
    UploadAssetShape,
    runUploadAsset as ToolRun,
  );
  register(
    "create_embedded",
    "Create embedded documents (e.g., tokens, items, effects) within a parent. Runs the full reliability pipeline with read-back of the parent.",
    CreateEmbeddedShape,
    runCreateEmbedded as ToolRun,
  );
  register(
    "update_embedded",
    "Update embedded documents within a parent. Each entry must carry its _id. Read-back verifies against parent; restores parent on mismatch.",
    UpdateEmbeddedShape,
    runUpdateEmbedded as ToolRun,
  );
  register(
    "delete_embedded",
    "Delete embedded documents by id. Runs dry-run and write.",
    DeleteEmbeddedShape,
    runDeleteEmbedded as ToolRun,
  );
  register(
    "create_quest",
    "Create a quest via Forien's Quest Log (requires the module to be enabled). Runs dry-run and write with read-back.",
    CreateQuestShape,
    runCreateQuest as ToolRun,
  );
  register(
    "update_quest",
    "Update a quest by id. Partial update with read-back verification of changed fields.",
    UpdateQuestShape,
    runUpdateQuest as ToolRun,
  );
  register(
    "delete_quest",
    "Delete a quest by id. Runs dry-run and write.",
    DeleteQuestShape,
    runDeleteQuest as ToolRun,
  );

  return server;
}
