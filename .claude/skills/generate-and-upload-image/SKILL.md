---
name: generate-and-upload-image
description: Generate an image with a LOCAL AI (a CLI like stable-diffusion.cpp / ComfyUI, or an Automatic1111/SD-Forge HTTP API) and put it into the running Foundry world via the foundry MCP tools — upload with upload_asset, then set it as an actor portrait, token texture, scene background, or journal image. Use when the user wants to "generate an image/portrait/map/token and add it to Foundry", "make art for this NPC/scene with a local model", or "use a local AI to create and upload a picture".
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
- If neither is configured, ask the user which local backend they run and what
  the invocation is — do **not** invent a command.

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
     [--backend cli|a1111] [--width 768 --height 768 --steps 30 --negative "..."]
   ```

   It writes the image, a base64 sidecar `<out>.b64`, and prints a one-line JSON
   summary `{ path, name, bytes, mimeType, b64Path }`. Sanity-check `bytes` (a
   few-hundred-byte file usually means the backend failed).

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

5. **Report**: the document touched, the field set, and the stored path. Offer to
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
