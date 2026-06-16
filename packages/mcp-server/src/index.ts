#!/usr/bin/env node
/**
 * Entry point: load config (the single read site), open the relay transport,
 * register the tools and serve over stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { RelayServer } from "./relay-server.js";
import { buildServer } from "./server.js";

export { loadConfig } from "./config.js";
export * from "./relay-transport.js";
export { RelayServer } from "./relay-server.js";
export * from "./reliability.js";
export * from "./tools.js";
export { buildServer } from "./server.js";

async function start(): Promise<void> {
  const config = loadConfig();
  // All diagnostics go to stderr — stdout carries the MCP JSON-RPC stream.
  const trace = config.trace
    ? (line: string) => console.error(`[foundry-mcp-bridge] ${line}`)
    : undefined;
  // The MCP server hosts the relay; the Foundry module connects out to it.
  const transport = new RelayServer({
    url: config.relayUrl,
    token: config.relayToken,
    defaultTimeoutMs: config.requestTimeoutMs,
    log: (level, message) =>
      console.error(`[foundry-mcp-bridge] ${level}: ${message}`),
  });
  const server = buildServer(transport, {
    token: config.relayToken,
    timeoutMs: config.requestTimeoutMs,
    log: trace,
  });
  if (config.trace) {
    console.error(
      `[foundry-mcp-bridge] ready: relay ${config.relayUrl}, timeout ${config.requestTimeoutMs}ms, trace on`,
    );
  }
  await server.connect(new StdioServerTransport());
}

export { start };

// Run only when executed directly (not when imported by tests/wrappers).
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(`[foundry-mcp-bridge] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
