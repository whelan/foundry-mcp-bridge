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
  runCreateDocument,
  runCreateScene,
  runUpdateDocument,
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

  return server;
}
