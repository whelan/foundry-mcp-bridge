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
  runDeleteDocument,
  runDuplicateDocument,
  runFindDocuments,
  runGetWorldInfo,
  runUploadAsset,
  runBrowseAssets,
  runBatchUploadAssets,
  runCreateEmbedded,
  runCreateQuest,
  runSearchCompendium,
  runImportFromCompendium,
} from "../packages/mcp-server/dist/index.js";
// Reuse the real dot-notation merge + embedded-field mapping instead of re-implementing them.
import { applyUpdate, embeddedField } from "@foundry-mcp-bridge/shared";

// --- tiny in-memory "Foundry" stub (stands in for the module) ---------------
const store = new Map(); // `${type}:${id}` -> doc
const rid = () => Math.random().toString(36).slice(2, 18).padEnd(16, "x");
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
      const u = applyUpdate(d, c.data);
      u._id = c.id;
      if (!env.dryRun) store.set(k, u);
      return ok(u);
    }
    case "delete":
      store.delete(`${c.documentType}:${c.id}`);
      return ok({ _id: c.id, deleted: true });
    case "duplicate": {
      const src = store.get(`${c.documentType}:${c.id}`);
      if (!src) return err("NOT_FOUND", `${c.documentType} ${c.id}`);
      const _id = rid();
      const copy = c.overrides ? applyUpdate(src, c.overrides) : structuredClone(src);
      copy._id = _id;
      if (!env.dryRun) store.set(`${c.documentType}:${_id}`, copy);
      return ok(copy);
    }
    case "createEmbedded": {
      const k = `${c.parentType}:${c.parentId}`;
      const parent = store.get(k);
      if (!parent) return err("NOT_FOUND", `${c.parentType} ${c.parentId}`);
      const created = c.data.map((d) => ({ ...d, _id: d._id || rid() }));
      if (!env.dryRun) {
        const field = embeddedField(c.embeddedName); // store under e.g. "tokens", not "Token"
        parent[field] = [...(parent[field] || []), ...created];
        store.set(k, parent);
      }
      return ok(created);
    }
    case "getWorldInfo":
      return ok({
        foundryVersion: "selftest",
        system: { id: "dnd5e", version: "0" },
        world: { id: "w", title: "Self Test" },
        folders: [],
        forge: { active: false, userId: null },
      });
    case "uploadAsset": {
      const path = `${c.target.replace(/\/$/, "")}/${c.filename}`;
      if (!env.dryRun) store.set(`asset:${path}`, true);
      return ok({ path });
    }
    case "browseAssets": {
      const prefix = c.target.replace(/\/$/, "");
      const files = [...store.keys()]
        .filter((k) => k.startsWith("asset:"))
        .map((k) => k.slice("asset:".length))
        .filter((p) => p.startsWith(prefix + "/") && !p.slice(prefix.length + 1).includes("/"));
      return ok({ dirs: [], files, target: prefix });
    }
    case "batchUploadAssets": {
      const prefix = c.target.replace(/\/$/, "");
      const results = c.files.map((f) => {
        const path = `${prefix}/${f.filename}`;
        if (c.skipExisting && store.has(`asset:${path}`)) {
          return { filename: f.filename, path, skipped: true };
        }
        if (!env.dryRun) store.set(`asset:${path}`, true);
        return { filename: f.filename, path };
      });
      return ok(results);
    }
    case "createQuest":
      return ok({ ...(c.data || {}), _id: rid() });
    case "searchCompendium":
      // Return a dummy result for testing (real implementation loads from fixtures)
      return ok([{ uuid: "Compendium.dnd5e.actors24.dummy", pack: "dnd5e.actors24", name: "Dummy", type: "Actor" }]);
    case "importFromCompendium": {
      // Simulate importing from compendium
      const _id = rid();
      const doc = { _id, name: "Imported Document", type: c.documentType };
      if (!env.dryRun) store.set(`${c.documentType}:${_id}`, doc);
      return ok(doc);
    }
    default:
      return err("UNSUPPORTED", c.action);
  }
}

const TOKEN = "selftest";
// Pass a trace logger so the selftest also exercises (and demonstrates) the
// per-command trace the real server emits to stderr.
const opts = { token: TOKEN, timeoutMs: 2000, log: (line) => console.log(line) };
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
show("duplicate_document (clone)", await runDuplicateDocument(server, { documentType: "Actor", id: newId, overrides: { name: "Clone" } }, opts));
show("find_documents (by id)", await runFindDocuments(server, { documentType: "Actor", id: newId }, opts));
show("get_world_info", await runGetWorldInfo(server, {}, opts));
show("upload_asset", await runUploadAsset(server, { source: "data", target: "worlds/selftest", filename: "probe.webp", contentBase64: "AAAA" }, opts));
show("batch_upload_assets", await runBatchUploadAssets(server, { source: "data", target: "worlds/selftest/scenes", files: [{ filename: "map1.webp", contentBase64: "AAAA" }, { filename: "map2.webp", contentBase64: "BBBB" }] }, opts));
show("browse_assets (after upload)", await runBrowseAssets(server, { source: "data", target: "worlds/selftest/scenes" }, opts));
show("batch_upload_assets (skipExisting)", await runBatchUploadAssets(server, { source: "data", target: "worlds/selftest/scenes", files: [{ filename: "map1.webp", contentBase64: "AAAA" }, { filename: "map3.webp", contentBase64: "CCCC" }], skipExisting: true }, opts));
show("create_document (Scene parent)", await runCreateDocument(server, { documentType: "Scene", data: { _id: "scene-self", name: "Embedded Parent" }, keepId: true }, opts));
show("create_embedded (Token)", await runCreateEmbedded(server, { parentType: "Scene", parentId: "scene-self", embeddedName: "Token", data: [{ name: "Goblin" }] }, opts));
show("create_quest", await runCreateQuest(server, { data: { name: "Find the Amulet" } }, opts));
show("delete_document", await runDeleteDocument(server, { documentType: "Actor", id: newId }, opts));
show("search_compendium (Goblin)", await runSearchCompendium(server, { documentType: "Actor", nameQuery: "Goblin" }, opts));
show("import_from_compendium (Tier 1)", await runImportFromCompendium(server, { documentType: "Actor", uuid: "Compendium.dnd5e.actors24.dummy" }, opts));

ws.close();
server.close();
console.log(
  failed
    ? "\nSELFTEST FAILED"
    : "\nSELFTEST PASSED — MCP server -> relay -> module -> read-back all working on this machine.",
);
process.exit(failed ? 1 : 0);
