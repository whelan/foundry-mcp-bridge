#!/usr/bin/env node
/**
 * Measure the per-session context cost of the MCP tool list: for each tool,
 * chars of name + description + JSON input schema exactly as the server sends
 * them in tools/list. Usage: npm run tools:size [-- --groups core,scenes]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, parseToolGroups } from "../packages/mcp-server/dist/index.js";

const gi = process.argv.indexOf("--groups");
const groups = parseToolGroups(gi > 0 ? process.argv[gi + 1] : "all");
const transport = { send: async () => { throw new Error("no relay"); }, close() {} };
const server = buildServer(transport, {}, null, null, null, { groups });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "tools-size", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();
const rows = tools.map((t) => {
  const d = (t.description ?? "").length;
  const s = JSON.stringify(t.inputSchema ?? {}).length;
  return { name: t.name, desc: d, schema: s, total: t.name.length + d + s };
});
rows.sort((x, y) => y.total - x.total);
const pad = (v, n) => String(v).padStart(n);
console.log(`${"tool".padEnd(34)}${pad("desc", 7)}${pad("schema", 8)}${pad("total", 8)}`);
for (const r of rows) console.log(`${r.name.padEnd(34)}${pad(r.desc, 7)}${pad(r.schema, 8)}${pad(r.total, 8)}`);
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
console.log(`${`TOTAL (${rows.length} tools)`.padEnd(34)}${pad(sum("desc"), 7)}${pad(sum("schema"), 8)}${pad(sum("total"), 8)}`);
await client.close();
