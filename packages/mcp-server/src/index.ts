#!/usr/bin/env node
/**
 * Entry point: load config (the single read site), open the relay transport,
 * register the tools and serve over stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { WebSocketRelayTransport } from "./relay-transport.js";
import { buildServer } from "./server.js";

export { loadConfig } from "./config.js";
export * from "./relay-transport.js";
export * from "./reliability.js";
export * from "./tools.js";
export { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const transport = new WebSocketRelayTransport({
    url: config.relayUrl,
    defaultTimeoutMs: config.requestTimeoutMs,
  });
  const server = buildServer(transport, {
    token: config.relayToken,
    timeoutMs: config.requestTimeoutMs,
  });
  await server.connect(new StdioServerTransport());
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[foundry-mcp-bridge] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
