#!/usr/bin/env node
/**
 * Standalone relay hub: owns RELAY_URL and nothing else. The Foundry module
 * connects to it, and every MCP server process joins it as a peer
 * (`?role=peer`), so any number of sessions share one module connection.
 */

import { loadConfig } from "./config.js";
import { RelayServer } from "./relay-server.js";

export async function startHub(): Promise<RelayServer> {
  const config = loadConfig();
  const server = new RelayServer({
    url: config.relayUrl,
    token: config.relayToken,
    defaultTimeoutMs: config.requestTimeoutMs,
    log: (level, message) => console.error(`[foundry-relay-hub] ${level}: ${message}`),
  });
  const port = await server.listening();
  console.error(`[foundry-relay-hub] listening on port ${port} (${config.relayUrl})`);
  const shutdown = (signal: string) => {
    console.error(`[foundry-relay-hub] ${signal}; shutting down`);
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHub().catch((e) => {
    console.error(`[foundry-relay-hub] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
