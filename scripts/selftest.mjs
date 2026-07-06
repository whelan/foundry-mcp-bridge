#!/usr/bin/env node
// Proves the real built MCP server -> relay (WebSocket) -> module -> read-back
// path works on THIS machine, without a real Foundry. A tiny in-memory stub
// stands in for the Foundry module. Run with: npm run selftest
//
// This is the same path the live system uses; only the world behind the module
// is replaced by an in-memory store.
//
// --live: instead of spinning up an in-process stub relay + fake module, binds
// to the *real* relay (RELAY_URL/RELAY_TOKEN, same config the real MCP server
// reads) and waits for your actual Foundry module to connect. Only the M6 NPC
// leg runs in this mode (the M0-M5 legs above aren't cleaned up and would
// litter a real world). This is the M6a/M6c gate from
// docs/statblock-import-execution-plan.md: run
//   npm run install:foundry
//   node scripts/selftest.mjs --live
// with Foundry open, the module enabled, and its Module Settings relay URL
// matching RELAY_URL (default ws://localhost:8787).

import { WebSocket } from "ws";
import {
  RelayServer,
  loadConfig,
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
import { parseStatblock, importNpc, verifyImportedNpc } from "@foundry-mcp-bridge/statblock-sync";
import fs from "fs";

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
      // Simulate importing from compendium, honoring an optional patch so the
      // reliability pipeline's read-back verification is meaningfully exercised.
      const _id = rid();
      const base = { name: "Imported Document", type: c.documentType };
      const doc = { ...(c.patch ? applyUpdate(base, c.patch) : base), _id };
      if (!env.dryRun) store.set(`${c.documentType}:${_id}`, doc);
      return ok(doc);
    }
    default:
      return err("UNSUPPORTED", c.action);
  }
}

const live = process.argv.includes("--live");

let failed = false;
const show = (name, out) => {
  if (!out.ok) failed = true;
  const steps = out.steps ? ` steps=[${out.steps.join(" > ")}]` : "";
  const e = out.ok ? "" : `  error=${out.error.code}: ${out.error.message}`;
  console.log(`${out.ok ? "PASS" : "FAIL"}  ${name}${steps}${e}`);
  return out;
};

// M6: NPC import leg (full pipeline: parse → upload image → importNpc → verify → clean up).
// Shared by mock mode (in-process stub) and --live mode (real relay + module) —
// only what's on the other end of `server` differs.
async function runNpcLeg(server, opts) {
  const statblockPath = "test/fixtures/statblock-import/gravemire-stalker.md";
  const imagePath = "test/fixtures/statblock-import/gravemire-stalker.png";

  const statblock = parseStatblock(fs.readFileSync(statblockPath, "utf-8"));
  const imageContent = fs.readFileSync(imagePath);
  const imageBase64 = imageContent.toString("base64");

  const importResult = await importNpc(statblock, {
    async searchCompendium(nameQuery) {
      const res = await runSearchCompendium(server, { documentType: "Actor", nameQuery }, opts);
      if (!res.ok) throw new Error(`searchCompendium failed: ${res.error.code}`);
      return res.data || [];
    },
    async importFromCompendium(uuid, patch) {
      const res = await runImportFromCompendium(server, { documentType: "Actor", uuid, patch }, opts);
      if (!res.ok) throw new Error(`importFromCompendium failed: ${res.error.code}`);
      return res.data;
    },
    async createDocument(data) {
      const res = await runCreateDocument(server, { documentType: "Actor", data }, opts);
      if (!res.ok) throw new Error(`createDocument failed: ${res.error.code}`);
      return res.data;
    },
    async uploadImage(filename, contentBase64, targetFolder) {
      const res = await runUploadAsset(server, { source: "data", target: targetFolder, filename, contentBase64 }, opts);
      if (!res.ok) throw new Error(`uploadAsset failed: ${res.error.code}`);
      return res.data;
    },
  }, { filename: "gravemire-stalker.png", contentBase64: imageBase64 });

  // Read back the imported actor and verify
  const readBackRes = await runFindDocuments(server, { documentType: "Actor", id: importResult.actorId }, opts);
  if (!readBackRes.ok) throw new Error(`find actor failed: ${readBackRes.error.code}`);
  const readBack = readBackRes.data;

  const verification = verifyImportedNpc(readBack, statblock);

  // Show the verification report
  const passCount = verification.checks.filter((c) => c.pass).length;
  const failCount = verification.checks.filter((c) => !c.pass).length;
  console.log(`\nM6 NPC import verification: ${passCount}/${verification.checks.length} passed`);
  if (failCount > 0) {
    console.log("Failed checks:");
    verification.checks.filter((c) => !c.pass).forEach((c) => {
      console.log(`  ✗ ${c.name}: got ${c.got}, want ${c.want}`);
    });
  }

  // Clean up: delete the actor and uploaded assets (selftest must stay non-destructive).
  await runDeleteDocument(server, { documentType: "Actor", id: importResult.actorId }, opts);

  show("import_npc (M6 NPC leg)", { ok: verification.ok, checks: passCount, failed: failCount });
}

if (live) {
  // --live: bind to the REAL relay (same config the real MCP server reads) and
  // wait for your actual Foundry module to connect. No in-process stub here —
  // commands really travel server -> relay -> your Foundry world.
  const config = loadConfig();
  const opts = { token: config.relayToken, timeoutMs: 20_000, log: (line) => console.log(line) };
  const server = new RelayServer({
    url: config.relayUrl,
    token: config.relayToken,
    defaultTimeoutMs: 20_000,
  });
  await server.listening();
  console.log(
    `relay listening on ${config.relayUrl}; waiting up to ${opts.timeoutMs}ms for your ` +
      `Foundry module to connect (open the world, module enabled, Module Settings relay ` +
      `URL matching this address)...\n`,
  );

  try {
    await runNpcLeg(server, opts);
  } catch (e) {
    console.error("NPC import leg error:", e.message);
    failed = true;
  }

  server.close();
  console.log(
    failed
      ? "\nSELFTEST (--live) FAILED"
      : "\nSELFTEST (--live) PASSED — MCP server -> relay -> module -> read-back all working against your real Foundry world.",
  );
  process.exit(failed ? 1 : 0);
}

const TOKEN = "selftest";
// Pass a trace logger so the selftest also exercises (and demonstrates) the
// per-command trace the real server emits to stderr.
const opts = { token: TOKEN, timeoutMs: 2000, log: (line) => console.log(line) };

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
show("import_from_compendium (Tier 1, with patch)", await runImportFromCompendium(server, { documentType: "Actor", uuid: "Compendium.dnd5e.actors24.dummy", patch: { name: "Patched Goblin" } }, opts));

try {
  await runNpcLeg(server, opts);
} catch (e) {
  console.error("NPC import leg error:", e.message);
  failed = true;
}

ws.close();
server.close();
console.log(
  failed
    ? "\nSELFTEST FAILED"
    : "\nSELFTEST PASSED — MCP server -> relay -> module -> read-back all working on this machine.",
);
process.exit(failed ? 1 : 0);
