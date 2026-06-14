#!/bin/bash
set -euo pipefail

# Only run dependency setup in Claude Code on the web (remote) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Install workspace dependencies (idempotent; benefits from container caching).
npm install

# Smoke-check the toolchain so the session starts ready to typecheck + test.
npm run typecheck
npm test
