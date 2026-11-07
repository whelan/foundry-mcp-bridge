/**
 * Per-call tool usage statistics, appended as JSONL (one line per call) so many
 * MCP processes can share one file safely. Recording never breaks a tool call:
 * IO errors are swallowed and reported on stderr.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ALL_TOOL_GROUPS, TOOL_CATALOG, type ToolGroup } from "./tool-groups.js";

export interface ToolStatRecord {
  /** ISO time the call finished. */
  ts: string;
  tool: string;
  group?: string;
  ok: boolean;
  /** Error code when ok is false (or "THROWN" if the handler threw). */
  error?: string;
  ms: number;
  /** Chars of the JSON-serialized arguments. */
  reqChars: number;
  /** Chars of the text returned to the model. */
  resChars: number;
  /** Random id per MCP server process. */
  session: string;
  pid: number;
  /** MCP client name from initialize clientInfo, when known. */
  client?: string;
}

export type StatInput = Omit<ToolStatRecord, "ts" | "session" | "pid">;

export class ToolStats {
  readonly session = randomUUID();
  private dirReady: Promise<unknown> | null = null;

  constructor(
    readonly file: string,
    private readonly onError: (message: string) => void = (m) => console.error(`[foundry-mcp-bridge] tool-stats: ${m}`),
  ) {}

  /** Append one record. Resolves even on failure. */
  async record(input: StatInput): Promise<void> {
    const rec: ToolStatRecord = { ts: new Date().toISOString(), ...input, session: this.session, pid: process.pid };
    try {
      this.dirReady ??= mkdir(dirname(this.file), { recursive: true });
      await this.dirReady;
      // One appendFile per line: O_APPEND writes of a short line are atomic enough
      // for concurrent processes sharing the file.
      await appendFile(this.file, JSON.stringify(rec) + "\n", "utf8");
    } catch (e) {
      this.dirReady = null;
      this.onError((e as Error).message);
    }
  }
}

// --- summarizer ---------------------------------------------------------------

export interface ToolSummary {
  tool: string;
  group: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgResChars: number;
  totalResChars: number;
  avgMs: number;
  lastUsed: string;
}

export interface StatsSummary {
  records: number;
  sessions: number;
  clients: string[];
  tools: ToolSummary[];
  neverUsed: string[];
  groups: { group: string; calls: number; sessionShare: number; verdict: "daily" | "occasional" | "extra" }[];
}

/** Parse JSONL, skipping blank or corrupt lines. */
export function parseStatsJsonl(text: string): ToolStatRecord[] {
  const out: ToolStatRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ToolStatRecord;
      if (r && typeof r.tool === "string") out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

const groupOf = (tool: string, rec?: string): string =>
  (TOOL_CATALOG as Record<string, ToolGroup>)[tool] ?? rec ?? "unknown";

/**
 * Summarize records. A group is "daily" when it is used in at least `dailyShare`
 * of sessions, "occasional" when used at all, "extra" when never used.
 */
export function summarizeStats(
  records: ToolStatRecord[],
  registered: string[] = Object.keys(TOOL_CATALOG),
  dailyShare = 0.5,
): StatsSummary {
  const byTool = new Map<string, ToolSummary & { ms: number }>();
  const sessions = new Set<string>();
  const groupSessions = new Map<string, Set<string>>();
  const clients = new Set<string>();
  for (const r of records) {
    sessions.add(r.session);
    if (r.client) clients.add(r.client);
    const group = groupOf(r.tool, r.group);
    let t = byTool.get(r.tool);
    if (!t) {
      t = { tool: r.tool, group, calls: 0, errors: 0, errorRate: 0, avgResChars: 0, totalResChars: 0, avgMs: 0, lastUsed: r.ts, ms: 0 };
      byTool.set(r.tool, t);
    }
    t.calls++;
    if (!r.ok) t.errors++;
    t.totalResChars += r.resChars ?? 0;
    t.ms += r.ms ?? 0;
    if (r.ts > t.lastUsed) t.lastUsed = r.ts;
    if (!groupSessions.has(group)) groupSessions.set(group, new Set());
    groupSessions.get(group)!.add(r.session);
  }
  const tools = [...byTool.values()]
    .map(({ ms, ...t }) => ({
      ...t,
      errorRate: t.errors / t.calls,
      avgResChars: Math.round(t.totalResChars / t.calls),
      avgMs: Math.round(ms / t.calls),
    }))
    .sort((a, b) => b.calls - a.calls);
  const neverUsed = registered.filter((n) => !byTool.has(n));
  const groupNames = [...new Set([...ALL_TOOL_GROUPS, ...groupSessions.keys()])];
  const groups = groupNames
    .map((group) => {
      const calls = tools.filter((t) => t.group === group).reduce((n, t) => n + t.calls, 0);
      const share = sessions.size ? (groupSessions.get(group)?.size ?? 0) / sessions.size : 0;
      const verdict: "daily" | "occasional" | "extra" = calls === 0 ? "extra" : share >= dailyShare ? "daily" : "occasional";
      return { group, calls, sessionShare: share, verdict };
    })
    .sort((a, b) => b.calls - a.calls);
  return { records: records.length, sessions: sessions.size, clients: [...clients], tools, neverUsed, groups };
}

/** Human-readable report. */
export function formatStatsSummary(s: StatsSummary): string {
  const lines: string[] = [];
  lines.push(`${s.records} calls across ${s.sessions} session(s)${s.clients.length ? `; clients: ${s.clients.join(", ")}` : ""}`);
  lines.push("");
  lines.push(`${"tool".padEnd(34)}${"group".padEnd(12)}${"calls".padStart(6)}${"err%".padStart(6)}${"avgRes".padStart(8)}${"totRes".padStart(9)}${"avgMs".padStart(7)}  last used`);
  for (const t of s.tools) {
    lines.push(
      `${t.tool.padEnd(34)}${t.group.padEnd(12)}${String(t.calls).padStart(6)}${(t.errorRate * 100).toFixed(0).padStart(6)}` +
        `${String(t.avgResChars).padStart(8)}${String(t.totalResChars).padStart(9)}${String(t.avgMs).padStart(7)}  ${t.lastUsed}`,
    );
  }
  lines.push("");
  lines.push(`Never used (${s.neverUsed.length}): ${s.neverUsed.join(", ") || "-"}`);
  lines.push("");
  lines.push("Groups:");
  for (const g of s.groups) {
    lines.push(`  ${g.group.padEnd(12)}${String(g.calls).padStart(6)} calls, in ${(g.sessionShare * 100).toFixed(0)}% of sessions -> ${g.verdict}`);
  }
  const daily = s.groups.filter((g) => g.verdict === "daily").map((g) => g.group);
  lines.push("");
  lines.push(`Suggested FOUNDRY_TOOLS=${daily.length ? daily.join(",") : "all"}  (add occasional groups when you need them)`);
  return lines.join("\n");
}
