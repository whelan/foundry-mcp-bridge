/**
 * Phase 2 MCP tools that talk to The Forge REST API *directly* (no relay).
 *
 * These mirror the relay-backed asset tools (browse_assets / upload_asset) but
 * bypass the Foundry module entirely — handy for pre-flight checks against the
 * Forge bucket without a running world. They produce the same {@link ToolOutcome}
 * shape as the relay tools so server.ts can render them identically.
 *
 * The Forge client is optional: when `FORGE_USER_ID` / `FORGE_API_KEY` aren't
 * configured the runners return a structured UNSUPPORTED error naming the keys,
 * rather than silently doing nothing.
 */

import { z } from "zod";
import { ForgeRestClient, ForgeRestError } from "./forge-rest.js";
import type { PipelineOptions, ToolOutcome } from "./reliability.js";

/** Either a ready client or null when Forge credentials aren't configured. */
export type ForgeClientRef = ForgeRestClient | null;

const NOT_CONFIGURED: ToolOutcome = {
  ok: false,
  steps: ["forge-config"],
  error: {
    code: "UNSUPPORTED",
    message:
      "The Forge direct API is not configured. Set FORGE_USER_ID and FORGE_API_KEY " +
      "(see .env.example / docs/forge-asset-manager.md) to enable forge_* tools.",
  },
};

/** Run a Forge call, mapping success/failure into a {@link ToolOutcome}. */
async function runForge(
  forge: ForgeClientRef,
  stepName: string,
  call: (client: ForgeRestClient) => Promise<unknown>,
  opts: PipelineOptions,
): Promise<ToolOutcome> {
  if (!forge) return NOT_CONFIGURED;
  const steps = [stepName];
  opts.log?.(`  → forge ${stepName}`);
  try {
    const data = await call(forge);
    opts.log?.(`  ← forge ${stepName} ok`);
    return { ok: true, data, steps };
  } catch (e) {
    if (e instanceof ForgeRestError) {
      opts.log?.(`  ← forge ${stepName} ERROR ${e.message}`);
      // 4xx that's clearly a missing path → NOT_FOUND; everything else INTERNAL.
      const code = e.status === 404 ? "NOT_FOUND" : e.status === 401 || e.status === 403 ? "AUTH" : "INTERNAL";
      return { ok: false, steps, error: { code, message: e.message, details: e.details } };
    }
    opts.log?.(`  ← forge ${stepName} ERROR ${(e as Error).message}`);
    return { ok: false, steps, error: { code: "INTERNAL", message: (e as Error).message } };
  }
}

// --- forge_browse_assets ----------------------------------------------------

export const ForgeBrowseAssetsShape = {
  path: z.string().min(1),
};
const ForgeBrowseAssets = z.object(ForgeBrowseAssetsShape);
export type ForgeBrowseAssetsArgs = z.infer<typeof ForgeBrowseAssets>;

export function runForgeBrowseAssets(
  forge: ForgeClientRef,
  args: ForgeBrowseAssetsArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runForge(forge, "forge-browse-assets", (c) => c.browseAssets({ path: args.path }), opts);
}

// --- forge_upload_asset -----------------------------------------------------

export const ForgeUploadAssetShape = {
  target: z.string().min(1),
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  mimeType: z.string().optional(),
};
const ForgeUploadAsset = z.object(ForgeUploadAssetShape);
export type ForgeUploadAssetArgs = z.infer<typeof ForgeUploadAsset>;

export function runForgeUploadAsset(
  forge: ForgeClientRef,
  args: ForgeUploadAssetArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runForge(
    forge,
    "forge-upload-asset",
    (c) =>
      c.uploadAsset({
        target: args.target,
        filename: args.filename,
        contentBase64: args.contentBase64,
        mimeType: args.mimeType,
      }),
    opts,
  );
}

// --- forge_create_folder ----------------------------------------------------

export const ForgeCreateFolderShape = {
  path: z.string().min(1),
};
const ForgeCreateFolder = z.object(ForgeCreateFolderShape);
export type ForgeCreateFolderArgs = z.infer<typeof ForgeCreateFolder>;

export function runForgeCreateFolder(
  forge: ForgeClientRef,
  args: ForgeCreateFolderArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  return runForge(forge, "forge-create-folder", (c) => c.createFolder({ path: args.path }), opts);
}
