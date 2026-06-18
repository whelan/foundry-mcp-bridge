#!/usr/bin/env bash
# Run FLUX.1-schnell locally on CPU via stable-diffusion.cpp.
#
# FLUX is a 12B-parameter model — on an Intel Mac (no usable Metal here) it runs
# on the CPU and is SLOW: expect several minutes per 512px image, and ~16 GB RAM
# while running. Only the Apache-licensed `schnell` variant (4 steps) is sane on
# this hardware. This is a quality/prompt-understanding upgrade over SD 1.5, not
# a speed one.
#
# Run ONCE:
#   ./scripts/setup-flux-cpu.sh            # build + download (~10 GB), no render
#   ./scripts/setup-flux-cpu.sh --smoke    # also render one test image (slow!)
#
# Then generate with the usual command (be patient):
#   ./scripts/make-image.sh "a red dragon, intricate detail" dragon.png
#
# Gated downloads: black-forest-labs hosts the VAE; if a download 401s, create a
# free Hugging Face token, accept the FLUX.1-schnell license once on its model
# page, then re-run with:  HF_TOKEN=hf_xxx ./scripts/setup-flux-cpu.sh
#
# Override any weight via env: FLUX_MODEL_URL / FLUX_VAE_URL / FLUX_CLIP_L_URL /
# FLUX_T5XXL_URL (and the matching *_FILE names).
set -euo pipefail

SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --smoke) SMOKE=1 ;;
    --no-smoke) SMOKE=0 ;;
    *) echo "setup: unknown flag '$arg'" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDCPP_DIR="$REPO/.sdcpp"
BUILD_DIR="$SDCPP_DIR/build-cpu"     # separate from the Metal build dir
BIN_DIR="$BUILD_DIR/bin"
FLUX_DIR="$REPO/models/flux"
ENV_FILE="$REPO/local-image-gen.env"

# CPU threads for sd.cpp. Defaults to PHYSICAL cores (the perf sweet spot for
# matmul — hyperthreads rarely help and often hurt). Override to try all logical
# cores:  SD_THREADS=$(sysctl -n hw.ncpu) ./scripts/setup-flux-cpu.sh
THREADS="${SD_THREADS:-$(sysctl -n hw.physicalcpu)}"

# Quantized weights — defaults sized to fit ~16 GB RAM. Override via env.
FLUX_MODEL_URL="${FLUX_MODEL_URL:-https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q4_K_S.gguf}"
FLUX_MODEL_FILE="${FLUX_MODEL_FILE:-flux1-schnell-Q4_K_S.gguf}"
FLUX_T5XXL_URL="${FLUX_T5XXL_URL:-https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf}"
FLUX_T5XXL_FILE="${FLUX_T5XXL_FILE:-t5-v1_1-xxl-encoder-Q4_K_M.gguf}"
FLUX_CLIP_L_URL="${FLUX_CLIP_L_URL:-https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors}"
FLUX_CLIP_L_FILE="${FLUX_CLIP_L_FILE:-clip_l.safetensors}"
FLUX_VAE_URL="${FLUX_VAE_URL:-https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors}"
FLUX_VAE_FILE="${FLUX_VAE_FILE:-ae.safetensors}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ "$(uname)" != "Darwin" ]]; then
  echo "setup: this script targets macOS." >&2
  exit 1
fi

# Download helper: skip if present, resume partials, optional HF auth.
dl() {
  local url="$1" dest="$2"
  if [[ -f "$dest" ]]; then say "Already have $(basename "$dest")"; return; fi
  say "Downloading $(basename "$dest")"
  local auth=()
  [[ -n "${HF_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $HF_TOKEN")
  curl -L --fail -C - "${auth[@]+"${auth[@]}"}" -o "$dest" "$url" || {
    echo "setup: download failed for $url" >&2
    echo "       If it was a 401/403, accept the model license on its HF page and" >&2
    echo "       re-run with HF_TOKEN=hf_xxx ./scripts/setup-flux-cpu.sh" >&2
    rm -f "$dest"; exit 1
  }
}

# 1. Toolchain (Xcode CLT, brew cmake/git, node).
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Xcode Command Line Tools (a GUI dialog will open)"
  xcode-select --install || true
  echo "Finish the install, then re-run." >&2; exit 1
fi
command -v brew >/dev/null 2>&1 || { echo "setup: install Homebrew (https://brew.sh) and re-run." >&2; exit 1; }
for tool in cmake git; do command -v "$tool" >/dev/null 2>&1 || { say "Installing $tool"; brew install "$tool"; }; done
command -v node >/dev/null 2>&1 || { echo "setup: Node >=20 required." >&2; exit 1; }

# 2. Clone sd.cpp if needed, build a CPU-only binary (Metal is unusable on this GPU).
if [[ ! -d "$SDCPP_DIR/.git" ]]; then
  say "Cloning stable-diffusion.cpp"
  git clone --recursive https://github.com/leejet/stable-diffusion.cpp "$SDCPP_DIR"
else
  git -C "$SDCPP_DIR" submodule update --init --recursive
fi
say "Configuring CPU build"
cmake -S "$SDCPP_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release -DSD_METAL=OFF -DGGML_METAL=OFF
say "Compiling (a few minutes)"
cmake --build "$BUILD_DIR" --config Release -j"$(sysctl -n hw.ncpu)"
SD_BIN=""
for cand in "$BIN_DIR/sd-cli" "$BIN_DIR/sd"; do [[ -x "$cand" ]] && { SD_BIN="$cand"; break; }; done
[[ -n "$SD_BIN" ]] || { echo "setup: build produced no sd/sd-cli binary in $BIN_DIR" >&2; exit 1; }
say "Built CLI: $SD_BIN"

# 3. Weights.
mkdir -p "$FLUX_DIR"
dl "$FLUX_MODEL_URL"  "$FLUX_DIR/$FLUX_MODEL_FILE"
dl "$FLUX_T5XXL_URL"  "$FLUX_DIR/$FLUX_T5XXL_FILE"
dl "$FLUX_CLIP_L_URL" "$FLUX_DIR/$FLUX_CLIP_L_FILE"
dl "$FLUX_VAE_URL"    "$FLUX_DIR/$FLUX_VAE_FILE"

# 4. Env. FLUX schnell: 4 steps, cfg-scale 1.0 (guidance-distilled, no negative).
say "Writing $ENV_FILE"
cat > "$ENV_FILE" <<EOF
# Generated by scripts/setup-flux-cpu.sh — FLUX.1-schnell on CPU (slow, ~mins/image).
# Consumed by scripts/make-image.sh (which sources it before gen-image.mjs).
IMAGE_GEN_BACKEND=cli
IMAGE_GEN_CMD='$SD_BIN --diffusion-model $FLUX_DIR/$FLUX_MODEL_FILE --vae $FLUX_DIR/$FLUX_VAE_FILE --clip_l $FLUX_DIR/$FLUX_CLIP_L_FILE --t5xxl $FLUX_DIR/$FLUX_T5XXL_FILE --threads $THREADS --seed -1 -p "{prompt}" --cfg-scale 1.0 --sampling-method euler --steps 4 -W {width} -H {height} -o "{out}"'
EOF

# 5. Optional (slow) smoke test.
if [[ "$SMOKE" == "1" ]]; then
  say "Smoke test: rendering one FLUX image on CPU (this takes several minutes)"
  mkdir -p "$REPO/generated-images"
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  node "$REPO/scripts/gen-image.mjs" \
    --prompt "a friendly green dragon, fantasy portrait, intricate detail" \
    --out "$REPO/generated-images/flux-smoke.png" --steps 4
  say "Smoke test OK -> generated-images/flux-smoke.png"
fi

cat <<EOF

FLUX setup complete. Generate (be patient — minutes per image on CPU):

  ./scripts/make-image.sh "a red dragon perched on a castle tower" dragon.png

FLUX-schnell wants ~4 steps (the env default). To switch back to a faster model,
re-run scripts/setup-sdcpp-metal.sh (SD 1.5) or scripts/setup-local-image-gen.sh
(sd-turbo) — they rewrite local-image-gen.env.
EOF
