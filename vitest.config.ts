import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TS source so tests don't depend
      // on a prior build step.
      "@foundry-mcp-bridge/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
      "@foundry-mcp-bridge/campaign-sync": fileURLToPath(
        new URL("./packages/campaign-sync/src/index.ts", import.meta.url),
      ),
      "@foundry-mcp-bridge/statblock-sync": fileURLToPath(
        new URL("./packages/statblock-sync/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
