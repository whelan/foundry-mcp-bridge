# foundry-mcp-bridge

MCP server + Foundry VTT V14 module that lets an AI create/update/delete
documents (actors, scenes, journals, roll tables, quests) in a **running**
Foundry world — locally and on The Forge.

See the design docs:

- [`docs/foundry-live-api-plan.md`](docs/foundry-live-api-plan.md) — architecture
  (module-relay approach), tools (§7), Forien's Quest Log (§7.1), update
  semantics (§7.2), reliability (§11).
- [`docs/foundry-mcp-bridge-project-plan.md`](docs/foundry-mcp-bridge-project-plan.md)
  — monorepo layout, config rules, mock-first test strategy.
- [`docs/setup-foundry-forge.md`](docs/setup-foundry-forge.md) — every
  configurable property and how to activate against local Foundry and The Forge.
- [`docs/local-test-quickstart.md`](docs/local-test-quickstart.md) — turnkey:
  check out the branch, open Claude Code, paste one prompt, test in your world.

## Packages

| Package | What it is |
| --- | --- |
| `packages/shared` | Wire protocol (zod `Command`/`CommandEnvelope`/`CommandResult`), object helpers, V14 scene builders. |
| `packages/foundry-module` | Foundry module (v13..v14): WebSocket relay client, GM-only command executor, settings. |
| `packages/mcp-server` | MCP server: config, relay transport, reliability pipeline, tools (`create_document`, `create_scene`, `update_document`, `show_image_file`, …). |
| `test/integration` | In-memory `mock-foundry` (Foundry key conventions, FilePicker `data`/`forgevtt`, injectable failures) used to test everything without a real Foundry. |

## Scene & token tools

`list_scenes`, `get_scene_state`, `switch_scene`, `place_token`, `move_tokens`, `remove_tokens`,
`toggle_condition`, `add_walls`, `add_lights` — all addressed in grid squares (square/gridless scenes).
`add_walls` also makes windows (movement blocked, sight and light pass) and Foundry 14 animated doors (`animation`:
swing, slide, swivel, ascend, descend; `double`, `flip`, `locked`, `open`). Every door gets one of Foundry's core
`canvas/doors` images, because Foundry only animates a door that has a texture: pick the look with `style` (wood, stone,
metal, portcullis) and `tone`, or give your own `texture` path; `add_lights` takes a `source` preset
(torch, fireplace, candle, lantern, daylight) and an `animation` such as `flame` or `pulse`.
Arbitrary canvas objects (tiles, drawings, notes, regions) go through `create_embedded` with pixel coordinates.

## Image generation (Codex)

`generate_image` makes art with the OpenAI Codex CLI and puts it into Foundry: `kind` picks the style and size
(portrait, token, battlemap, handout, item) and `apply` sets it as an actor portrait/token, item image, scene
background (V13 and V14 levels), a new scene sized to the image, or a hidden journal page. Generation takes a minute or
more, so it runs as a job: `generate_image` waits `waitSeconds`, otherwise returns a `jobId` for `check_image_job`
(or `cancel_image_job`). On macOS: `npm i -g @openai/codex`, `codex login`, and set `CODEX_BIN=/opt/homebrew/bin/codex`.
The writes it makes are verified, logged and undoable like any other tool's.

`build_floorplan_scene` builds a whole building in one call from a small spec (rooms in grid cells with furnishings,
doors, windows, lights). It draws a blueprint, has Codex paint over it as a webp (`codex:false` keeps the blueprint),
creates a scene of exactly cols x rows cells, and derives every wall, door, window and light from the spec so they match
the picture. The result carries a preview per floor with the walls and lights drawn over the picture. Needs Foundry 14 and,
for the size check, the roof and the preview, ImageMagick (`magick`). Undo it with `undo_change`.

For several floors give `floors: [{name, rooms, openings, lights}]` (ground floor first, up to 4) and
`stairs: [{at: [col, row], dir, length, width, from}]`. Each floor becomes a Foundry 14 **Level** with its own painting,
walls and lights; a stair is one region over both levels with Foundry's own "change level" prompt, so a token that steps
on it can go up or down. An upper room must sit inside the floor below, a stair must lie inside one room on both floors
and every upper floor needs a stair. `roof` (default on) adds one roof tile painted from a footprint guide and masked
to the outline of the house with ImageMagick; it has `FADE` and `VISION` occlusion, so from outside it is solid and shows
only what a token sees through a window or door, and it fades when a token walks under it. `roofStyle` is a hint for the
painter ("thatched roof", "slate roof"). A two-floor house with a roof is three Codex runs, run one after another in a
single image job (one `jobId`); `roof:false` drops the third. The single-floor `rooms`/`openings`/`lights` input still works
and is the same as one floor. `add_walls` and `add_lights` also take `levels` (level ids) to put their documents on one level.

## Safety: permissions, change log, undo

- **Permissions** (Module Settings, GM only): per category (actors, scenes, journals, tables, items, macros,
  playlists, folders) choose *Read only*, *Create and edit, never delete* (default) or *Full*. Refused writes
  return `FORBIDDEN`. **Deleting is off until you enable *Full* for that category.**
- **Change log**: every document write made through the bridge is logged with the command that reverses it.
  `list_changes` browses it, `undo_change` reverses one change or a whole tool call (`requestId`).
  Quests, uploads and macro runs are not logged. Set `CHANGE_LOG=0` to turn it off.

## Develop

```bash
npm install
npm run typecheck
npm test
```

Everything is developed and tested mock-first — no real Foundry required.

To produce the browser-loadable Foundry module bundle:

```bash
npm run bundle:module   # -> packages/foundry-module/dist/index.js (self-contained)
```

## Local image generation (optional)

Generate art with a **local** diffusion model and push it into your world. The
upload path (`upload_asset` MCP tool) already exists; this adds the generator.

Turnkey on macOS. Two backends, same everyday command (`make-image.sh`):

```bash
# CPU path (any Mac) — diffusers + 1-step sd-turbo:
./scripts/setup-local-image-gen.sh

# stable-diffusion.cpp path (DreamShaper 8 / SD 1.5) — Metal if usable, else CPU:
./scripts/setup-sdcpp-metal.sh        # add SD_NO_METAL=1 on discrete AMD GPUs

# FLUX.1-schnell on CPU (12B model — high quality, slow, ~10 GB, ~16 GB RAM):
./scripts/setup-flux-cpu.sh

# then, with either:
./scripts/make-image.sh "a red dragon" /tmp/dragon.png   # generate any time
```

Both write `local-image-gen.env`; run whichever setup matches your hardware
(re-run the other to switch). On an Intel Mac the GPU path *can* be faster, but
**ggml's Metal kernels are tuned for Apple Silicon**: on a discrete AMD Radeon
Pro (e.g. Vega 20) sampling is often far slower than CPU and the VAE decode can
hit the macOS GPU watchdog, producing a blank/white image. If that happens, use
the CPU build (`SD_NO_METAL=1 ./scripts/setup-sdcpp-metal.sh`) or the sd-turbo
CPU path. PyTorch's MPS backend is likewise unreliable on Intel+AMD.

`make-image.sh` writes the image plus a base64 sidecar; the
`generate-and-upload-image` skill then uploads it and sets it as an actor
portrait, token, scene background, or journal image. For other backends (an
Automatic1111/SD-Forge WebUI, or any image CLI) point `IMAGE_GEN_CMD` /
`SD_WEBUI_URL` at `scripts/gen-image.mjs` directly — see the skill.

## Configuration

The MCP server reads config in exactly one place (`packages/mcp-server/src/config.ts`):

1. environment / `.env` (see [`.env.example`](.env.example)),
2. `dev.config.json` — only when `NODE_ENV=development` (see
   [`dev.config.example.json`](dev.config.example.json)).

Missing required config fails loudly. No connection strings are hardcoded. The
Foundry module gets its relay URL + token from Module Settings.
