import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import { buildServer, type ServerExtras } from "../../packages/mcp-server/src/server.js";
import { ALL_TOOL_GROUPS, TOOL_CATALOG, parseToolGroups } from "../../packages/mcp-server/src/tool-groups.js";
import {
  ToolStats,
  formatStatsSummary,
  parseStatsJsonl,
  summarizeStats,
  type ToolStatRecord,
} from "../../packages/mcp-server/src/tool-stats.js";
import { loadConfig } from "../../packages/mcp-server/src/config.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "fmb-stats-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function connect(extras: ServerExtras, mock = new MockFoundry()) {
  const server = buildServer(new MockTransport(mock), {}, null, null, null, extras);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "profile-test-client", version: "1.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("tool profiles", () => {
  it("registers every catalog tool by default (all)", async () => {
    const client = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(Object.keys(TOOL_CATALOG).sort());
  });

  it("registers only the selected groups", async () => {
    const client = await connect({ groups: parseToolGroups("core,quests") });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("find_documents");
    expect(names).toContain("create_quest");
    expect(names).not.toContain("add_walls");
    expect(names).not.toContain("build_floorplan_scene");
    for (const n of names) expect(["core", "quests"]).toContain(TOOL_CATALOG[n as keyof typeof TOOL_CATALOG]);
  });

  it("parses all/empty/implied groups and rejects unknown ones by naming valid groups", () => {
    expect([...parseToolGroups(undefined)]).toEqual(ALL_TOOL_GROUPS);
    expect([...parseToolGroups(" all ")]).toEqual(ALL_TOOL_GROUPS);
    expect(parseToolGroups("floorplan").has("images")).toBe(true);
    expect(() => parseToolGroups("core,bogus")).toThrowError(/"bogus".*Valid groups: core, compendium/);
  });

  it("config: FOUNDRY_TOOLS and TOOL_STATS", () => {
    const cwd = tmp();
    const base = { RELAY_URL: "ws://x:1", XDG_STATE_HOME: cwd };
    const cfg = loadConfig({ env: { ...base, FOUNDRY_TOOLS: "core,scenes" }, cwd });
    expect([...cfg.toolGroups]).toEqual(["core", "scenes"]);
    expect(cfg.toolStatsFile).toMatch(/tool-stats\.jsonl$/);
    expect(loadConfig({ env: { ...base, TOOL_STATS: "0" }, cwd }).toolStatsFile).toBeNull();
    expect(loadConfig({ env: { ...base, TOOL_STATS_FILE: "/x/s.jsonl" }, cwd }).toolStatsFile).toBe("/x/s.jsonl");
    expect(() => loadConfig({ env: { ...base, FOUNDRY_TOOLS: "nope" }, cwd })).toThrowError(/FOUNDRY_TOOLS.*Valid groups/);
  });
});

describe("find_documents tool output", () => {
  it("returns summary fields for a query, full doc by id", async () => {
    const mock = new MockFoundry();
    const client = await connect({}, mock);
    const created = await client.callTool({
      name: "create_document",
      arguments: { documentType: "Actor", data: { name: "Kip", type: "npc", system: { big: "x".repeat(500) } } },
    });
    const id = JSON.parse((created.content as { text: string }[])[0]!.text).data._id;
    const q = await client.callTool({ name: "find_documents", arguments: { documentType: "Actor", query: { name: "Kip" } } });
    const qText = (q.content as { text: string }[])[0]!.text;
    expect(qText).not.toContain("xxxxx");
    expect(JSON.parse(qText).data[0]).toMatchObject({ _id: id, name: "Kip", type: "npc" });
    const full = await client.callTool({ name: "find_documents", arguments: { documentType: "Actor", query: { name: "Kip" }, full: true } });
    expect((full.content as { text: string }[])[0]!.text).toContain("xxxxx");
    const one = await client.callTool({ name: "find_documents", arguments: { documentType: "Actor", id } });
    expect((one.content as { text: string }[])[0]!.text).toContain("xxxxx");
  });
});

describe("tool stats", () => {
  it("records one JSONL line per call with ok/error, sizes and client name", async () => {
    const file = join(tmp(), "nested", "stats.jsonl");
    const stats = new ToolStats(file);
    const client = await connect({ stats });
    await client.callTool({ name: "get_world_info", arguments: {} });
    await client.callTool({ name: "cancel_image_job", arguments: { jobId: "nope" } });
    await new Promise((r) => setTimeout(r, 50));
    const recs = parseStatsJsonl(readFileSync(file, "utf8"));
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ tool: "get_world_info", group: "core", ok: true, client: "profile-test-client", session: stats.session, pid: process.pid });
    expect(recs[0]!.resChars).toBeGreaterThan(0);
    expect(recs[0]!.reqChars).toBe(2);
    expect(recs[1]).toMatchObject({ tool: "cancel_image_job", ok: false, error: "UNSUPPORTED" });
  });

  it("never breaks a call when the stats file cannot be written", async () => {
    const blocker = join(tmp(), "file");
    writeFileSync(blocker, "");
    const errors: string[] = [];
    const stats = new ToolStats(join(blocker, "stats.jsonl"), (m) => errors.push(m));
    const client = await connect({ stats });
    const res = await client.callTool({ name: "get_world_info", arguments: {} });
    expect(res.isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 50));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("summarizes per tool, never-used tools and daily/extra groups", () => {
    const rec = (tool: string, session: string, ok = true, resChars = 100, ts = "2026-01-01T00:00:00Z"): ToolStatRecord => ({
      ts, tool, ok, ms: 10, reqChars: 5, resChars, session, pid: 1, ...(ok ? {} : { error: "X" }),
    });
    const text = [
      rec("find_documents", "s1"),
      rec("find_documents", "s2", false, 300, "2026-02-01T00:00:00Z"),
      rec("update_document", "s2"),
      rec("add_walls", "s1"),
      rec("create_quest", "s3"),
    ].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n";
    const s = summarizeStats(parseStatsJsonl(text));
    expect(s.records).toBe(5);
    expect(s.sessions).toBe(3);
    const find = s.tools.find((t) => t.tool === "find_documents")!;
    expect(find).toMatchObject({ calls: 2, errors: 1, errorRate: 0.5, totalResChars: 400, avgResChars: 200, lastUsed: "2026-02-01T00:00:00Z" });
    expect(s.neverUsed).toContain("build_floorplan_scene");
    expect(s.neverUsed).not.toContain("find_documents");
    const verdict = Object.fromEntries(s.groups.map((g) => [g.group, g.verdict]));
    expect(verdict).toMatchObject({ core: "daily", scenes: "occasional", quests: "occasional", forge: "extra" });
    expect(formatStatsSummary(s)).toContain("Suggested FOUNDRY_TOOLS=core");
  });
});
