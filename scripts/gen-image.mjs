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
//       (--out /tmp/dragon.png | --name dragon.png [--out-dir images]) \
//       [--backend cli|a1111|codex] [--width 768] [--height 768] \
//       [--steps 30] [--negative "blurry, text"] [--no-sidecar]
//
// Destination: --out is used verbatim. Otherwise --name lands in the first of
// --out-dir, $IMAGE_GEN_OUT_DIR, "outputDir" from ./.imagegen.json, or
// ./images — so each project can carry its own image location in a small
// committed .imagegen.json: { "outputDir": "images", "codex": { "model": "..." } }
//
// Backends (pick with --backend or IMAGE_GEN_BACKEND, default "cli"):
//   cli    — run a local CLI that writes the image file itself. Provide the
//            command template in IMAGE_GEN_CMD with placeholders {prompt} {out}
//            {width} {height} {steps} {negative}. Examples:
//              IMAGE_GEN_CMD='sd -p "{prompt}" -o "{out}" --steps {steps}'
//              IMAGE_GEN_CMD='python comfy_cli.py --prompt "{prompt}" --out "{out}"'
//   a1111  — POST to an Automatic1111 / SD-Forge WebUI HTTP API (it returns
//            base64 directly). Set SD_WEBUI_URL (default http://127.0.0.1:7860).
//   codex  — drive the OpenAI Codex CLI (`codex exec`) non-interactively. Codex
//            saves into its own cache ($CODEX_HOME/generated_images/<session>/)
//            and its sandbox cannot copy into the workspace, so this script
//            locates the file via the session id and moves it to the
//            destination itself. Model: --codex-model, "codex.model" in
//            .imagegen.json, or $IMAGE_GEN_CODEX_MODEL (else codex's default).
//            --steps/--negative are diffusion-specific and ignored; --width/
//            --height become a size hint in the prompt. Timeout:
//            $IMAGE_GEN_TIMEOUT_MS (default 300000). Binary: $IMAGE_GEN_CODEX_BIN
//            (default "codex"; use an absolute path under a minimal PATH).
//            Codex's built-in tool always writes PNG; if --out/--name asks for
//            a different extension (e.g. --name portrait.webp — smaller files
//            for committing into a repo/Obsidian vault), this script converts
//            with `magick`/`convert` (install ImageMagick if neither is on PATH).
//
// Output: writes the image to the destination, writes "<out>.b64" (raw base64,
// no newlines) unless --no-sidecar, and prints a one-line JSON summary to stdout
// (path, bytes, mimeType, b64Path) — never the base64 itself, to keep logs sane.

import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  // txt2img always returns PNG regardless of the requested destination's
  // extension (the same constraint Codex's built-in tool has) — decode to a
  // PNG temp file and let convertImage handle any extension mismatch, same
  // as backendCodex. Without this, --name foo.webp would silently write raw
  // PNG bytes to a .webp path.
  const tempSrc = `${args.out}.a1111-source.png`;
  await writeFile(tempSrc, Buffer.from(clean, "base64"));
  await convertImage(tempSrc, args.out);
}

// --- codex backend helpers (pure; unit-tested in test/unit/gen-image.test.mjs) ---

// `codex exec --json` emits JSONL whose first event is
// {"type":"thread.started","thread_id":"<uuid>"} — and that uuid is exactly the
// directory name under $CODEX_HOME/generated_images/. Without --json the
// banner has a "session id: <uuid>" line; keep it as a fallback for drift.
export function parseCodexSessionId(lines) {
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // not JSON (banner/progress line) — keep scanning
    }
  }
  const m = lines.join("\n").match(/session id:\s*([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

const GENERATED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// From the session dir's entries ({ name, mtimeMs }), pick the newest image;
// anything else generated in the same session is reported, not silently lost.
export function pickGeneratedImage(entries) {
  const images = entries
    .filter((e) => GENERATED_IMAGE_EXTS.has(extname(e.name).toLowerCase()))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (images.length === 0) return null;
  return { chosen: images[0], extras: images.slice(1) };
}

// Destination precedence: --out verbatim; else --name inside the first of
// --out-dir, $IMAGE_GEN_OUT_DIR, config outputDir, "images". Null if neither
// --out nor --name was given.
export function resolveOutPath(args, config, env, cwd) {
  if (args.out) return args.out;
  if (!args.name) return null;
  const dir =
    args["out-dir"] ?? env.IMAGE_GEN_OUT_DIR ?? config?.outputDir ?? "images";
  return resolve(cwd, dir, args.name);
}

// Codex's own copy attempts fail in its sandbox (unsupported exec_command), so
// tell it up front not to try — we move the file ourselves afterwards.
export function buildCodexPrompt(args) {
  let prompt =
    "Use the image generation tool to generate exactly one image:\n\n" +
    `${args.prompt}\n\n` +
    "Do not attempt to save, copy, move, or verify the file — only generate it.";
  if (args.width && args.height) {
    prompt += ` Target size: ${args.width}x${args.height}.`;
  }
  return prompt;
}

async function readImagegenConfig(cwd) {
  let raw;
  try {
    raw = await readFile(join(cwd, ".imagegen.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const config = JSON.parse(raw);
    return typeof config === "object" && config !== null ? config : null;
  } catch (e) {
    console.error(`gen-image: ignoring invalid .imagegen.json: ${e.message}`);
    return null;
  }
}

// rename() fails with EXDEV across filesystems (codex's cache lives under
// $HOME; the project may be on another volume) — fall back to copy + unlink.
async function moveFile(src, dest) {
  try {
    await rename(src, dest);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    await copyFile(src, dest);
    await unlink(src);
  }
}

// Spawn an argv-form command (no shell); resolve on exit 0, reject with an
// Error naming the exit code otherwise. Distinct from runShell above: that one
// takes a single user-supplied template string and needs a shell to expand
// quoting the way IMAGE_GEN_CMD authors write it; this one runs a fixed argv
// array we constructed ourselves, so no shell is involved.
function spawnPromise(bin, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`)),
    );
  });
}

// Codex's built-in image tool has no format option — it always writes PNG
// (A1111's txt2img has the same constraint). If the caller asked for a
// different extension (typically --name foo.webp, e.g. to keep an Obsidian
// vault's images small), convert with whichever of ImageMagick's binaries is
// on PATH; otherwise just move the bytes as-is. A mismatched extension left
// unconverted would silently mislabel the file (a .webp that's actually PNG),
// so this is not optional when extensions differ.
const IMAGE_CONVERTERS = ["magick", "convert"];

async function convertImage(src, dest) {
  if (extname(src).toLowerCase() === extname(dest).toLowerCase()) {
    await moveFile(src, dest);
    return;
  }
  // Convert into a same-directory temp file, not `dest` directly: if the
  // converter is killed or crashes mid-write, only the temp file is left
  // corrupt — `dest` (which may already hold a good, previously-generated
  // image) is untouched until the rename below, which is atomic since both
  // paths are on the same filesystem by construction.
  const tempDest = `${dest}.converting${extname(dest)}`;
  let converted = false;
  for (const bin of IMAGE_CONVERTERS) {
    try {
      await spawnPromise(bin, [src, tempDest]);
      converted = true;
      break;
    } catch (e) {
      if (e?.code === "ENOENT") continue; // this binary isn't installed, try the next
      await unlink(tempDest).catch(() => {}); // best-effort: clean up a partial write
      throw e;
    }
  }
  if (!converted) {
    fail(
      `no image converter on PATH to turn ${extname(src)} into ${extname(dest)} ` +
        `(install ImageMagick: \`brew install imagemagick\`), or request a matching --name extension`,
    );
    return;
  }
  await rename(tempDest, dest);
  // Cleanup is independent of which binary succeeded — an unlink failure here
  // is a "couldn't remove the source" problem, not "no converter is
  // installed", so it must not feed back into the ENOENT retry loop above
  // (that would misreport a successful conversion as a missing binary).
  await unlink(src);
}

function outputTail(lines) {
  return lines.slice(-20).join("\n");
}

function runCodex(argv) {
  return new Promise((resolvePromise, reject) => {
    // stdin must be ignored: `codex exec` reads a piped stdin as extra prompt.
    // IMAGE_GEN_CODEX_BIN: an absolute path when the parent (e.g. an MCP client) starts us with a minimal PATH.
    const child = spawn(process.env.IMAGE_GEN_CODEX_BIN ?? "codex", argv, { stdio: ["ignore", "pipe", "inherit"] });
    const timeoutMs = Number(process.env.IMAGE_GEN_TIMEOUT_MS ?? 300_000);
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex timed out after ${timeoutMs}ms (IMAGE_GEN_TIMEOUT_MS)`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      process.stderr.write(chunk); // progress visibility; stdout stays JSON-only
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        e?.code === "ENOENT"
          ? new Error("backend 'codex' needs the OpenAI Codex CLI (`codex`) on PATH")
          : e,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/);
      if (code === 0) resolvePromise(lines);
      else reject(new Error(`codex exited with code ${code}\n${outputTail(lines)}`));
    });
  });
}

async function backendCodex(args, config) {
  const model =
    args["codex-model"] ?? config?.codex?.model ?? process.env.IMAGE_GEN_CODEX_MODEL;
  const argv = ["exec", "--json", "-s", "read-only", "--skip-git-repo-check"];
  if (model) argv.push("-m", model);
  argv.push(buildCodexPrompt(args));
  console.error("gen-image: running codex exec (this can take a minute)...");
  const lines = await runCodex(argv);

  const sessionId = parseCodexSessionId(lines);
  if (!sessionId) {
    fail(`no codex session id found in the output (CLI format drift?)\n${outputTail(lines)}`);
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sessionDir = join(codexHome, "generated_images", sessionId);
  const names = await readdir(sessionDir).catch(() => []);
  const entries = [];
  for (const name of names) {
    const s = await stat(join(sessionDir, name)).catch(() => null);
    if (s?.isFile()) entries.push({ name, mtimeMs: s.mtimeMs });
  }
  const picked = pickGeneratedImage(entries);
  if (!picked) {
    fail(
      `codex completed but produced no image in ${sessionDir} ` +
        `(did it answer in text or refuse?)\n${outputTail(lines)}`,
    );
  }
  if (picked.extras.length > 0) {
    console.error(
      `gen-image: codex produced ${picked.extras.length + 1} images; using the newest, ` +
        `leaving in ${sessionDir}: ${picked.extras.map((e) => e.name).join(", ")}`,
    );
  }
  await convertImage(join(sessionDir, picked.chosen.name), args.out);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt) fail("missing --prompt");
  const config = await readImagegenConfig(process.cwd());
  const outPath = resolveOutPath(args, config, process.env, process.cwd());
  if (!outPath) fail("missing --out or --name");
  args.out = outPath;
  await mkdir(dirname(resolve(outPath)), { recursive: true });
  const backend = args.backend ?? process.env.IMAGE_GEN_BACKEND ?? "cli";

  if (backend === "cli") await backendCli(args);
  else if (backend === "a1111") await backendA1111(args);
  else if (backend === "codex") await backendCodex(args, config);
  else fail(`unknown backend '${backend}' (expected cli | a1111 | codex)`);

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

// Only run when executed directly — the pure helpers above are imported by
// the unit tests.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => fail(e?.message ?? String(e)));
