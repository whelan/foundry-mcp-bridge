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
| `packages/mcp-server` | MCP server: config, relay transport, reliability pipeline, tools (`create_document`, `create_scene`, `update_document`). |
| `test/integration` | In-memory `mock-foundry` (Foundry key conventions, FilePicker `data`/`forgevtt`, injectable failures) used to test everything without a real Foundry. |

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
