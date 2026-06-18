#!/usr/bin/env python3
"""Generate one image with a local Stable Diffusion model (Hugging Face diffusers).

Defaults to `stabilityai/sd-turbo`: a distilled model that produces a 512x512
image in a SINGLE step, which is what makes it usable on a CPU-only machine like
an Intel MacBook Pro 2019 (Apple's MPS/Metal acceleration only exists on Apple
Silicon, so diffusion here runs on the CPU).

This is the local "generate" backend for scripts/gen-image.mjs (the `cli`
backend invokes it). It only writes an image file; uploading into Foundry is the
job of the `upload_asset` MCP tool — see
.claude/skills/generate-and-upload-image/SKILL.md.

Heavy imports (torch/diffusers) are done inside main() so `python -m py_compile`
and `--help` work without the model stack installed.

Usage:
  python scripts/sd_generate.py --prompt "a red dragon portrait" --out dragon.png \
      [--width 512] [--height 512] [--steps 1] [--negative "..."] \
      [--seed 42] [--model stabilityai/sd-turbo]
"""

import argparse
import os
import sys


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate one image with a local SD model.")
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--negative", default="")
    p.add_argument("--width", type=int, default=512)
    p.add_argument("--height", type=int, default=512)
    # sd-turbo is a 1-step model; raise for non-turbo checkpoints.
    p.add_argument("--steps", type=int, default=1)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument(
        "--model",
        default=os.environ.get("SD_MODEL", "stabilityai/sd-turbo"),
        help="Hugging Face model id or local path (env SD_MODEL).",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    try:
        import torch
        from diffusers import AutoPipelineForText2Image
    except Exception as e:  # pragma: no cover - depends on local install
        print(
            f"sd_generate: missing deps ({e}).\n"
            "Run scripts/setup-local-image-gen.sh first.",
            file=sys.stderr,
        )
        return 1

    # Intel Macs have no usable MPS backend; fall back to CPU (float32).
    if torch.backends.mps.is_available():
        device, dtype = "mps", torch.float16
    elif torch.cuda.is_available():
        device, dtype = "cuda", torch.float16
    else:
        device, dtype = "cpu", torch.float32

    print(
        f"sd_generate: model={args.model} device={device} "
        f"{args.width}x{args.height} steps={args.steps}",
        file=sys.stderr,
    )

    pipe = AutoPipelineForText2Image.from_pretrained(args.model, torch_dtype=dtype)
    pipe = pipe.to(device)
    pipe.set_progress_bar_config(disable=None)

    generator = None
    if args.seed is not None:
        generator = torch.Generator(device="cpu").manual_seed(args.seed)

    # Turbo models are trained for guidance_scale=0.0 (no classifier-free
    # guidance), so the negative prompt has no effect on them — that's expected.
    image = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative or None,
        num_inference_steps=max(1, args.steps),
        guidance_scale=0.0,
        width=args.width,
        height=args.height,
        generator=generator,
    ).images[0]

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    image.save(args.out)
    print(f"sd_generate: wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
