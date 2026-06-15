/**
 * MCP server wiring. Registers the tools (live-api-plan §7) and routes each call
 * through the reliability pipeline. The pipeline/tool logic is what tests cover;
 * this file is the thin MCP-SDK adapter.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export function buildServer(transport: RelayTransport, opts: PipelineOptions = {}): McpServer {
  const server = new McpServer({ name: "foundry-mcp-bridge", version: "0.1.0" });

  server.registerTool(
    "create_document",
    {
      description:
        "Create a Foundry document of the given type. Runs the full reliability pipeline (validate, dry-run, write, read-back verify, rollback on mismatch).",
      inputSchema: CreateDocumentShape,
    },
    async (args) => toCallResult(await runCreateDocument(transport, args, opts)),
  );

  server.registerTool(
    "create_scene",
    {
      description:
        "Create a V14 Scene from high-level parameters (built with the shared scene builders), then run the reliability pipeline.",
      inputSchema: CreateSceneShape,
    },
    async (args) => toCallResult(await runCreateScene(transport, args, opts)),
  );

  server.registerTool(
    "update_document",
    {
      description:
        "Partially update a Foundry document by id (Foundry dot-notation supported). Read-back verifies the changed fields and restores on mismatch.",
      inputSchema: UpdateDocumentShape,
    },
    async (args) => toCallResult(await runUpdateDocument(transport, args, opts)),
  );

  server.registerTool(
    "delete_document",
    {
      description: "Delete a Foundry document by id. Runs dry-run and write; no rollback possible.",
      inputSchema: DeleteDocumentShape,
    },
    async (args) => toCallResult(await runDeleteDocument(transport, args, opts)),
  );

  server.registerTool(
    "duplicate_document",
    {
      description:
        "Clone an existing Foundry document by id, with optional field overrides (e.g. a new name). Runs the full reliability pipeline; rolls back the copy on read-back failure.",
      inputSchema: DuplicateDocumentShape,
    },
    async (args) => toCallResult(await runDuplicateDocument(transport, args, opts)),
  );

  server.registerTool(
    "find_documents",
    {
      description:
        "Query and read Foundry documents. Pass id for a single document, or query for shallow field matching. Returns document(s) for inspection.",
      inputSchema: FindDocumentsShape,
    },
    async (args) => toCallResult(await runFindDocuments(transport, args, opts)),
  );

  server.registerTool(
    "create_embedded",
    {
      description:
        "Create embedded documents (e.g., tokens, items, effects) within a parent. Runs the full reliability pipeline with read-back of the parent.",
      inputSchema: CreateEmbeddedShape,
    },
    async (args) => toCallResult(await runCreateEmbedded(transport, args, opts)),
  );

  server.registerTool(
    "update_embedded",
    {
      description:
        "Update embedded documents within a parent. Each entry must carry its _id. Read-back verifies against parent; restores parent on mismatch.",
      inputSchema: UpdateEmbeddedShape,
    },
    async (args) => toCallResult(await runUpdateEmbedded(transport, args, opts)),
  );

  server.registerTool(
    "delete_embedded",
    {
      description: "Delete embedded documents by id. Runs dry-run and write.",
      inputSchema: DeleteEmbeddedShape,
    },
    async (args) => toCallResult(await runDeleteEmbedded(transport, args, opts)),
  );

  server.registerTool(
    "create_quest",
    {
      description:
        "Create a quest via Forien's Quest Log (requires the module to be enabled). Runs dry-run and write with read-back.",
      inputSchema: CreateQuestShape,
    },
    async (args) => toCallResult(await runCreateQuest(transport, args, opts)),
  );

  server.registerTool(
    "update_quest",
    {
      description:
        "Update a quest by id. Partial update with read-back verification of changed fields.",
      inputSchema: UpdateQuestShape,
    },
    async (args) => toCallResult(await runUpdateQuest(transport, args, opts)),
  );

  server.registerTool(
    "delete_quest",
    {
      description: "Delete a quest by id. Runs dry-run and write.",
      inputSchema: DeleteQuestShape,
    },
    async (args) => toCallResult(await runDeleteQuest(transport, args, opts)),
  );

  return server;
}
