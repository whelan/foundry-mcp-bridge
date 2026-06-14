#!/bin/bash
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

# Install deps and build artifacts so the session starts ready: the MCP server
# (dist/) is needed by .mcp.json, and the Foundry module bundle by Foundry.
npm install
npm run build
npm run bundle:module

# In web/remote sessions also run the full gate (typecheck + tests).
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  npm run typecheck
  npm test
fi
