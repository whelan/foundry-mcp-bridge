#!/usr/bin/env node
// Generate an image with a LOCAL AI backend, then hand it off for upload to
// Foundry. This is the "generate" half of the generate-and-upload-image skill;
// the "upload" half is the existing `upload_asset` MCP tool (the agent reads the
// base64 sidecar this writes and passes it along — see
// .claude/skills/generate-and-upload-image/SKILL.md).
//
// It deliberately does NOT talk to Foundry or the relay: in the live topology
// the MCP server owns the relay hub and the Foundry module is its sole client,
// so uploads must go through the `upload_asset` MCP tool, not a second relay
// connection. This script only produces a file + a base64 sidecar.
//
// Usage:
//   node scripts/gen-image.mjs --prompt "a red dragon portrait, dramatic light" \
//       --out /tmp/dragon.png [--backend cli|a1111] [--width 768] [--height 768] \
//       [--steps 30] [--negative "blurry, text"] [--no-sidecar]
//
// Backends (pick with --backend or IMAGE_GEN_BACKEND, default "cli"):
//   cli    — run a local CLI that writes the image file itself. Provide the
//            command template in IMAGE_GEN_CMD with placeholders {prompt} {out}
//            {width} {height} {steps} {negative}. Examples:
//              IMAGE_GEN_CMD='sd -p "{prompt}" -o "{out}" --steps {steps}'
//              IMAGE_GEN_CMD='python comfy_cli.py --prompt "{prompt}" --out "{out}"'
//   a1111  — POST to an Automatic1111 / SD-Forge WebUI HTTP API (it returns
//            base64 directly). Set SD_WEBUI_URL (default http://127.0.0.1:7860).
//
// Output: writes the image to --out, writes "<out>.b64" (raw base64, no
// newlines) unless --no-sidecar, and prints a one-line JSON summary to stdout
// (path, bytes, mimeType, b64Path) — never the base64 itself, to keep logs sane.

import { spawn } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

function parseArgs(argv) {
  const out = { sidecar: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-sidecar") { out.sidecar = false; continue; }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    i++;
    out[key] = val;
  }
  return out;
}

function fail(msg) {
  console.error(`gen-image: ${msg}`);
  process.exit(1);
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function mimeFor(path) {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// Substitute {prompt} {out} {width} {height} {steps} {negative} into a template.
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(prompt|out|width|height|steps|negative)\}/g, (_, k) =>
    vars[k] ?? "",
  );
}

function runShell(cmd) {
  return new Promise((resolve, reject) => {
    // Use a shell so quoted placeholders in IMAGE_GEN_CMD behave as written.
    const child = spawn(cmd, { shell: true, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`backend exited with code ${code}`)),
    );
  });
}

async function backendCli(args) {
  const tpl = process.env.IMAGE_GEN_CMD;
  if (!tpl) {
    fail(
      "backend 'cli' needs IMAGE_GEN_CMD, e.g.\n" +
        `  IMAGE_GEN_CMD='sd -p "{prompt}" -o "{out}" --steps {steps}'`,
    );
  }
  const cmd = fillTemplate(tpl, {
    prompt: args.prompt.replace(/"/g, '\\"'),
    out: args.out,
    width: String(args.width ?? 512),
    height: String(args.height ?? 512),
    steps: String(args.steps ?? 30),
    negative: (args.negative ?? "").replace(/"/g, '\\"'),
  });
  console.error(`gen-image: running cli backend: ${cmd}`);
  await runShell(cmd);
  // The CLI is responsible for writing args.out; confirm it did.
  await stat(args.out).catch(() => fail(`backend did not produce ${args.out}`));
}

async function backendA1111(args) {
  const base = (process.env.SD_WEBUI_URL ?? "http://127.0.0.1:7860").replace(/\/$/, "");
  const body = {
    prompt: args.prompt,
    negative_prompt: args.negative ?? "",
    width: Number(args.width ?? 512),
    height: Number(args.height ?? 512),
    steps: Number(args.steps ?? 30),
  };
  console.error(`gen-image: POST ${base}/sdapi/v1/txt2img`);
  let res;
  try {
    res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`cannot reach SD WebUI at ${base} (is it running with --api?): ${e.message}`);
  }
  if (!res.ok) fail(`SD WebUI returned ${res.status} ${res.statusText}`);
  const json = await res.json();
  const b64 = json?.images?.[0];
  if (!b64) fail("SD WebUI response had no images");
  // A1111 may prefix a data URL; strip it.
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  await writeFile(args.out, Buffer.from(clean, "base64"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt) fail("missing --prompt");
  if (!args.out) fail("missing --out");
  const backend = args.backend ?? process.env.IMAGE_GEN_BACKEND ?? "cli";

  if (backend === "cli") await backendCli(args);
  else if (backend === "a1111") await backendA1111(args);
  else fail(`unknown backend '${backend}' (expected cli | a1111)`);

  const bytes = await readFile(args.out);
  const summary = {
    path: args.out,
    name: basename(args.out),
    bytes: bytes.length,
    mimeType: mimeFor(args.out),
    b64Path: null,
  };
  if (args.sidecar) {
    const b64Path = `${args.out}.b64`;
    await writeFile(b64Path, bytes.toString("base64"));
    summary.b64Path = b64Path;
  }
  console.log(JSON.stringify(summary));
}

main().catch((e) => fail(e?.message ?? String(e)));
