#!/usr/bin/env node
/**
 * Summarize the MCP tool usage stats JSONL (TOOL_STATS_FILE, default
 * <state dir>/tool-stats.jsonl). Usage: npm run tools:stats [-- path/to/file.jsonl] [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStateDir, formatStatsSummary, parseStatsJsonl, summarizeStats } from "../packages/mcp-server/dist/index.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const file = args.find((a) => !a.startsWith("--")) ?? process.env.TOOL_STATS_FILE ?? join(defaultStateDir(), "tool-stats.jsonl");
if (!existsSync(file)) {
  console.error(`No stats file at ${file} (set TOOL_STATS_FILE or pass a path).`);
  process.exit(1);
}
const summary = summarizeStats(parseStatsJsonl(readFileSync(file, "utf8")));
console.log(json ? JSON.stringify(summary, null, 2) : `${file}\n${formatStatsSummary(summary)}`);
