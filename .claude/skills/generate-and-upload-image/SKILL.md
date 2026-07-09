---
name: generate-and-upload-image
description: Generate an image with a local backend (stable-diffusion.cpp / ComfyUI CLI, an Automatic1111/SD-Forge HTTP API, or the OpenAI Codex CLI's image tool) and either drop it into the project's image directory or put it into the running Foundry world via the foundry MCP tools — upload with upload_asset, then set it as an actor portrait, token texture, scene background, or journal image. Use when the user wants to "generate an image/portrait/map/token and add it to Foundry", "make art for this NPC/scene with a local model", "generate an image with codex", or "create a picture and save it in the project".
---

# Generate an image with a local AI and upload it into Foundry

This wires a **local** image generator to the live Foundry path. There are two
halves, and they stay separate on purpose:

1. **Generate (local, outside the bridge).** A diffusion model — not an LLM —
   produces the pixels: e.g. `sd` (stable-diffusion.cpp), a ComfyUI CLI, or an
   Automatic1111 / SD-Forge WebUI. The bridge does **not** ship one; you drive
   it via `scripts/gen-image.mjs` (a thin, dependency-free wrapper).
2. **Upload + reference (the bridge).** The existing `upload_asset` MCP tool
   stores the file in Foundry and returns its path; then `update_document` /
   `create_scene` references that path on a document.

> Why not upload from the script directly? In the live topology the MCP server
> *owns* the relay hub and the Foundry module is its only client, so a second
> relay connection would supersede the GM's. Uploads therefore go through the
> `upload_asset` MCP tool — i.e. through you, the agent.

## Prerequisites

- The `mcp__foundry__*` tools must be present (Foundry running, GM logged in,
  module enabled, relay URL/token matching). If they aren't, the world isn't
  reachable — say so; don't try to upload.
- A local backend, selected by `--backend` / `IMAGE_GEN_BACKEND`:
  - **`cli`** (default): set `IMAGE_GEN_CMD` to a command that writes the file,
    with placeholders `{prompt} {out} {width} {height} {steps} {negative}`, e.g.
    `IMAGE_GEN_CMD='sd -p "{prompt}" -o "{out}" --steps {steps}'`.
  - **`a1111`**: an Automatic1111/SD-Forge WebUI started with `--api`; set
    `SD_WEBUI_URL` (default `http://127.0.0.1:7860`).
  - **`codex`**: the OpenAI Codex CLI (`codex` on PATH, logged in) — zero local
    model setup. Codex saves into its own cache and its sandbox cannot copy
    into the workspace, so the wrapper locates the file via the session id and
    moves it into place itself. `--steps`/`--negative` don't apply; model via
    `--codex-model` / `codex.model` in `.imagegen.json` / `IMAGE_GEN_CODEX_MODEL`.
- If none is configured, prefer `codex` when the `codex` CLI is on PATH;
  otherwise ask the user which local backend they run and what the invocation
  is — do **not** invent a command.

### Turnkey macOS setup (Intel, e.g. MacBook Pro 2019)

There's a ready-made local stack. Pick the backend for the hardware, one-time:

```bash
./scripts/setup-local-image-gen.sh   # CPU: diffusers + 1-step sd-turbo (any Mac)
./scripts/setup-sdcpp-metal.sh       # GPU: stable-diffusion.cpp + Metal (Intel Mac + AMD Radeon Pro)
```

Both write `local-image-gen.env`; the GPU path is much faster on an Intel Mac
with a discrete AMD GPU. (PyTorch MPS is unreliable on Intel+AMD, so the GPU path
uses stable-diffusion.cpp — SD 1.5 likes ~20-30 steps, pass `--steps 20`.)

Then generation is a single command, and you can skip step 2's raw `gen-image.mjs`
call below — use this instead (it sources `local-image-gen.env` for you):

```bash
./scripts/make-image.sh "a red dragon perched on a castle tower" /tmp/dragon.png
```

It writes the image + `<out>.b64` and prints the JSON summary, exactly like
`gen-image.mjs`, so continue from step 3 (upload).

## Workflow

1. **Pick the target document and field.** Map the user's intent to where the
   image lands:

   | Target | documentType | Field to set |
   | --- | --- | --- |
   | Actor portrait | `Actor` | `img` |
   | Actor default token | `Actor` | `prototypeToken.texture.src` |
   | Scene background | `Scene` | `background` (via `create_scene`) or `update_document` `background.src` |
   | Journal page image | `JournalEntry` page | page `src` (image-type page) or inline `<img>` in HTML |
   | Item icon | `Item` | `img` |

   Choose a sensible `target` directory and `filename` (lowercase, no spaces,
   keep the extension), and a `source` (`data` local, or `forgevtt` on The Forge
   — ask if unsure).

2. **Generate** into a temp file:

   ```bash
   node scripts/gen-image.mjs \
     --prompt "<vivid prompt for the subject>" \
     --out /tmp/<filename> \
     [--backend cli|a1111|codex] [--width 768 --height 768 --steps 30 --negative "..."]
   ```

   It writes the image, a base64 sidecar `<out>.b64`, and prints a one-line JSON
   summary `{ path, name, bytes, mimeType, b64Path }`. Sanity-check `bytes` (a
   few-hundred-byte file usually means the backend failed).

   **Generate into the project instead:** when the user wants the image in the
   repo rather than uploaded to Foundry, replace `--out` with `--name <filename>`
   — the destination directory comes from `--out-dir`, `$IMAGE_GEN_OUT_DIR`,
   `outputDir` in the project's `.imagegen.json`, or `./images`, in that order.
   The file is then already at its final path: report it and **stop** (skip
   steps 3–5).

   ```bash
   node scripts/gen-image.mjs --backend codex \
     --prompt "a shiba inu wearing sunglasses" --name shiba.png
   ```

3. **Upload** with the MCP tool. Read the sidecar text (`b64Path`) and pass it
   as `contentBase64`:

   - `upload_asset` `{ source, target: "<dir>", filename: "<name>",`
     `contentBase64: "<sidecar contents>", mimeType: "<from summary>" }`
   - It runs as a terminal write (dry-run validates the target, then uploads; no
     read-back). On success the result carries the stored **path** — capture it.
   - On a non-`ok` result, surface `error.code` (`VALIDATION` for a bad target,
     `AUTH`, `TIMEOUT`) instead of retrying blindly.

   Pass the sidecar's raw base64 straight through; don't re-encode the binary
   yourself, and don't paste the image into the conversation.

4. **Reference it** on the document with the stored path from step 3:
   - New scene → `create_scene` with `background: "<path>"`.
   - Existing doc → `update_document` `{ documentType, id, data: { <field>: "<path>" } }`
     (e.g. `{ img: "<path>" }`, or `{ "prototypeToken.texture.src": "<path>" }`).
   - These run dry-run → write → read-back → rollback; read the result's `ok`.

5. **Want a ring/frame around the token art?** Don't hand-set the token's
   `ring.*` fields via `update_document` for AI-generated art — in testing, a
   token whose `ring.enabled`/`colors`/`subject.texture` were set directly via
   the document API never rendered the ring shader (confirmed on an otherwise
   byte-for-byte matching config: PNG vs WEBP, with/without alpha, small vs
   large, fresh vs mutated token — none of it mattered; a same-shape update on
   an *official* dnd5e compendium token rendered the ring fine, so it's
   specific to externally-generated files, root cause not found). The reliable
   path is the **vtta-tokenizer** module's own editor, which bakes a frame
   directly into a new exported image instead of using the dynamic-ring
   shader:
   - `game.actors.get("<id>").sheet.render(true)` → the sheet's header `⋮`
     menu → **Tokenizer**. It auto-loads the actor's current portrait/token
     images into the Avatar/Token panes with a frame already applied.
   - Click **Apply**. It writes a new file (typically
     `tokenizer/npc-images/<name>.Token.webp`) and updates the actor's
     `prototypeToken.texture.src` to it — `ring.enabled` stays `false`; the
     frame is baked into the pixels, not a shader effect.
   - Propagate to any already-placed scene token with `update_document`
     `{ documentType: "Actor", ... }` on the actor is not enough — the scene
     token has its own copy of `texture.src`; update the `Token` embedded
     document (`scene.tokens.get(id).update({...})` in the browser console, or
     `update_document` with `documentType: "Token"`-style embedded update) to
     match, or just delete and re-drop the token from the sidebar.
   - If the module isn't enabled, `game.modules.get("vtta-tokenizer")?.active`
     tells you before trying the menu path.

6. **Report**: the document touched, the field set, and the stored path. Offer to
   tweak the prompt and regenerate if the user wants a different look.

## Guardrails

- Writes hit the **live** world. Confirm before overwriting an existing image on
  a document the user cares about; never delete without explicit confirmation.
- Generating multiple images? Show the plan (subjects, target docs) and get a
  go-ahead before a batch, and reuse one temp file per subject.
- Keep the base64 out of the conversation — work via the sidecar file and the
  tool call; large inline blobs waste context and clutter the transcript.
- The image is generated by a model: tell the user it's AI-generated if it
  matters for their world (licensing/consistency), and don't claim it depicts
  anything you can't verify.
- If a token needs a visible ring/frame, go straight to the vtta-tokenizer
  editor (step 5) rather than scripting `ring.*` fields — don't sink time
  re-deriving this from scratch.
