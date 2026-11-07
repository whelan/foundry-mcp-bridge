#!/usr/bin/env node
/**
 * Entry point: load config (the single read site), open the relay transport,
 * register the tools and serve over stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AutoRelayTransport } from "./relay-peer.js";
import { buildServer } from "./server.js";
import { ForgeRestClient } from "./forge-rest.js";
import { ChangeLog } from "./change-log.js";
import { createCodexRunner, ImageJobs } from "./image-gen.js";
import type { ImageJobMeta } from "./image-tools.js";

export { loadConfig } from "./config.js";
export * from "./relay-transport.js";
export { RelayServer } from "./relay-server.js";
export * from "./relay-peer.js";
export * from "./reliability.js";
export * from "./tools.js";
export * from "./forge-rest.js";
export * from "./forge-tools.js";
export * from "./change-log.js";
export * from "./change-tools.js";
export * from "./scene-tools.js";
export * from "./image-gen.js";
export * from "./image-tools.js";
export { buildServer } from "./server.js";

async function start(): Promise<void> {
  const config = loadConfig();
  // All diagnostics go to stderr — stdout carries the MCP JSON-RPC stream.
  const trace = config.trace
    ? (line: string) => console.error(`[foundry-mcp-bridge] ${line}`)
    : undefined;
  // The MCP server hosts the relay (the Foundry module connects out to it) --
  // unless another process (another MCP session or `npm run relay:hub`) already
  // owns the port, in which case we join it as a peer and share its module.
  const transport = new AutoRelayTransport({
    url: config.relayUrl,
    token: config.relayToken,
    defaultTimeoutMs: config.requestTimeoutMs,
    log: (level, message) =>
      console.error(`[foundry-mcp-bridge] ${level}: ${message}`),
  });
  const mode = await transport.start();
  console.error(`[foundry-mcp-bridge] info: relay mode ${mode} (${config.relayUrl})`);
  // Phase 2: enable the direct Forge REST tools only when both credentials are
  // present (they're optional; the forge_* tools report UNSUPPORTED otherwise).
  const forge =
    config.forgeUserId && config.forgeApiKey
      ? new ForgeRestClient({
          userId: config.forgeUserId,
          apiKey: config.forgeApiKey,
          baseUrl: config.forgeApiBaseUrl,
          timeoutMs: config.requestTimeoutMs,
        })
      : null;
  const server = buildServer(
    transport,
    {
      token: config.relayToken,
      timeoutMs: config.requestTimeoutMs,
      log: trace,
    },
    forge,
    config.changeLogFile ? new ChangeLog(config.changeLogFile) : null,
    {
      jobs: new ImageJobs<ImageJobMeta>(
        createCodexRunner({ codexBin: config.imageGen.codexBin, model: config.imageGen.model, timeoutMs: config.imageGen.timeoutMs }),
      ),
      outputDir: config.imageGen.outputDir,
    },
  );
  if (config.trace) {
    console.error(
      `[foundry-mcp-bridge] ready: relay ${config.relayUrl}, timeout ${config.requestTimeoutMs}ms, ` +
        `forge ${forge ? "on" : "off"}, trace on`,
    );
  }
  // The MCP client (Claude Code) closing our stdin -- because it quit, crashed,
  // or was killed by a Mac sleep/wake hiccup -- otherwise leaves this process
  // running forever: StdioServerTransport only listens for stdin "data"/"error",
  // never "end", and the open relay WebSocketServer keeps the event loop alive
  // regardless. An orphan like that squats the relay port, so the *next*
  // session's server can never bind it and fails immediately on connect. Exit
  // as soon as our input ends so the port is free for the next attempt.
  process.stdin.on("end", () => {
    console.error("[foundry-mcp-bridge] stdin closed (client gone); shutting down");
    transport.close();
    process.exit(0);
  });
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
