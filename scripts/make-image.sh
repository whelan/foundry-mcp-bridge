#!/usr/bin/env bash
# Everyday LOCAL image generation. Run scripts/setup-local-image-gen.sh once
# first, then:
#
#   ./scripts/make-image.sh "a red dragon perched on a castle tower" [out.png] [extra gen-image.mjs args]
#
# Produces the image plus a base64 sidecar (<out>.b64) and prints a one-line JSON
# summary. Uploading into Foundry is a separate step done by the
# 'generate-and-upload-image' skill via the upload_asset MCP tool.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/local-image-gen.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "make-image: $ENV_FILE not found — run ./scripts/setup-local-image-gen.sh first." >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo 'usage: make-image.sh "<prompt>" [out.png] [--width 512 --height 512 --steps 1 --negative "..."]' >&2
  exit 2
fi

PROMPT="$1"; shift
if [[ $# -gt 0 && "$1" != --* ]]; then
  OUT="$1"; shift
else
  mkdir -p "$REPO/generated-images"
  OUT="$REPO/generated-images/$(date +%Y%m%d-%H%M%S).png"
fi

set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

node "$REPO/scripts/gen-image.mjs" --prompt "$PROMPT" --out "$OUT" "$@"
