#!/usr/bin/env node
// Proves the real built MCP server -> relay (WebSocket) -> module -> read-back
// path works on THIS machine, without a real Foundry. A tiny in-memory stub
// stands in for the Foundry module. Run with: npm run selftest
//
// This is the same path the live system uses; only the world behind the module
// is replaced by an in-memory store.

import { WebSocket } from "ws";
import {
  RelayServer,
  runCreateDocument,
  runCreateScene,
  runUpdateDocument,
} from "../packages/mcp-server/dist/index.js";

// --- tiny in-memory "Foundry" stub (stands in for the module) ---------------
const store = new Map(); // `${type}:${id}` -> doc
const rid = () => Math.random().toString(36).slice(2, 18).padEnd(16, "x");
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const expand = (flat) => {
  const o = {};
  for (const [p, v] of Object.entries(flat)) {
    const ks = p.split(".");
    let c = o;
    for (let i = 0; i < ks.length - 1; i++) {
      if (!isObj(c[ks[i]])) c[ks[i]] = {};
      c = c[ks[i]];
    }
    c[ks[ks.length - 1]] = v;
  }
  return o;
};
const merge = (b, o) => {
  const out = { ...b };
  for (const [k, v] of Object.entries(o)) out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v) : v;
  return out;
};
function handle(env) {
  const c = env.command;
  const id = env.id;
  const ok = (data) => ({ id, ok: true, data });
  const err = (code, message) => ({ id, ok: false, error: { code, message } });
  switch (c.action) {
    case "create": {
      const _id = c.data._id || rid();
      const doc = { ...c.data, _id };
      if (!env.dryRun) store.set(`${c.documentType}:${_id}`, doc);
      return ok(doc);
    }
    case "find": {
      if (c.id) {
        const d = store.get(`${c.documentType}:${c.id}`);
        return d ? ok(d) : err("NOT_FOUND", `${c.documentType} ${c.id}`);
      }
      return ok([...store.values()]);
    }
    case "update": {
      const k = `${c.documentType}:${c.id}`;
      const d = store.get(k);
      if (!d) return err("NOT_FOUND", `${c.documentType} ${c.id}`);
      const u = merge(structuredClone(d), expand(c.data));
      u._id = c.id;
      if (!env.dryRun) store.set(k, u);
      return ok(u);
    }
    case "delete":
      store.delete(`${c.documentType}:${c.id}`);
      return ok({ _id: c.id, deleted: true });
    default:
      return err("UNSUPPORTED", c.action);
  }
}

const TOKEN = "selftest";
const opts = { token: TOKEN, timeoutMs: 2000 };
let failed = false;
const show = (name, out) => {
  if (!out.ok) failed = true;
  const steps = out.steps ? ` steps=[${out.steps.join(" > ")}]` : "";
  const e = out.ok ? "" : `  error=${out.error.code}: ${out.error.message}`;
  console.log(`${out.ok ? "PASS" : "FAIL"}  ${name}${steps}${e}`);
  return out;
};

const server = new RelayServer({ url: "ws://localhost:0", token: TOKEN, defaultTimeoutMs: 2000 });
const port = await server.listening();
const ws = new WebSocket(`ws://localhost:${port}?token=${TOKEN}`);
ws.on("message", (d) => ws.send(JSON.stringify(handle(JSON.parse(d.toString())))));
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
await new Promise((r) => setTimeout(r, 20));

console.log(`relay listening on ws://localhost:${port}; stub module connected.\n`);

show("create_document (Actor 'Probe')", await runCreateDocument(server, { documentType: "Actor", data: { name: "Probe", type: "npc" } }, opts));
show("create_scene ('Self Test Scene')", await runCreateScene(server, { name: "Self Test Scene", gridSize: 100 }, opts));
const created = show("create_document (Actor to update)", await runCreateDocument(server, { documentType: "Actor", data: { name: "Updatable" } }, opts));
const newId = created.ok ? created.data._id : "missing";
show("update_document (rename)", await runUpdateDocument(server, { documentType: "Actor", id: newId, data: { name: "Updated" } }, opts));

ws.close();
server.close();
console.log(
  failed
    ? "\nSELFTEST FAILED"
    : "\nSELFTEST PASSED — MCP server -> relay -> module -> read-back all working on this machine.",
);
process.exit(failed ? 1 : 0);
