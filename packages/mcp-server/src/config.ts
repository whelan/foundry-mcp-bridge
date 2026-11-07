/**
 * The ONE place the MCP server reads configuration. No connection strings are
 * ever hardcoded. Sources, in precedence order (first wins):
 *   1. process.env (populated by the shell or a loaded .env)
 *   2. a .env file in the working directory (parsed here)
 *   3. dev.config.json — ONLY when NODE_ENV=development
 * Missing required config fails loudly, naming the offending key.
 *
 * See docs/foundry-mcp-bridge-project-plan.md (config rules).
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseToolGroups, type ToolGroup } from "./tool-groups.js";

export interface ServerConfig {
  /** WebSocket URL of the relay the Foundry module connects to. */
  relayUrl: string;
  /** Shared secret; must match the Foundry module's relay token if set. */
  relayToken?: string;
  /** Per-command transport timeout (ms). */
  requestTimeoutMs: number;
  /** Emit a full command/result trace to stderr (default on; RELAY_TRACE=0 to mute). */
  trace: boolean;
  /** Optional: The Forge user id, enabling the Phase 2 direct REST tools. */
  forgeUserId?: string;
  /** Optional: The Forge API key (paired with forgeUserId). */
  forgeApiKey?: string;
  /** Optional: override the Forge API base URL (default https://forge-vtt.com/api). */
  forgeApiBaseUrl?: string;
  /** JSONL file of the change log; null when CHANGE_LOG=0 turns the log (and undo) off. */
  changeLogFile: string | null;
  /** Codex image generation (the generate_image tool). */
  imageGen: { codexBin: string; outputDir: string; model?: string; timeoutMs: number };
  /** Tool groups to register (FOUNDRY_TOOLS: comma list or `all`, default all). */
  toolGroups: ReadonlySet<ToolGroup>;
  /** JSONL usage-stats file (TOOL_STATS_FILE); null when TOOL_STATS=0. */
  toolStatsFile: string | null;
}

/** Per-user state directory: ~/Library/Application Support on macOS, XDG state elsewhere. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "foundry-mcp-bridge");
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "foundry-mcp-bridge");
}

const ConfigSchema = z.object({
  relayUrl: z
    .string({ required_error: "relayUrl is required (set RELAY_URL)" })
    .min(1, "relayUrl must not be empty (set RELAY_URL)"),
  relayToken: z.string().min(1).optional(),
  forgeUserId: z.string().min(1).optional(),
  forgeApiKey: z.string().min(1).optional(),
  forgeApiBaseUrl: z.string().url().optional(),
  requestTimeoutMs: z.coerce.number().int().positive().default(10_000),
  // raw.trace arrives as string|undefined (env / .env / dev.config via toString).
  trace: z
    .string()
    .optional()
    .transform((v) => v === undefined || (v !== "0" && v !== "false")),
  changeLog: z
    .string()
    .optional()
    .transform((v) => v === undefined || (v !== "0" && v !== "false")),
  changeLogDir: z.string().min(1).optional(),
  codexBin: z.string().min(1).default("codex"),
  imageOutputDir: z.string().min(1).optional(),
  imageCodexModel: z.string().min(1).optional(),
  imageTimeoutMs: z.coerce.number().int().positive().default(300_000),
  foundryTools: z.string().optional(),
  toolStats: z
    .string()
    .optional()
    .transform((v) => v === undefined || (v !== "0" && v !== "false")),
  toolStatsFile: z.string().min(1).optional(),
});

type RawConfig = Record<string, string | undefined>;

/** Minimal .env parser (KEY=VALUE, # comments, optional quotes). */
function parseDotEnv(text: string): RawConfig {
  const out: RawConfig = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const envFile = readIfExists(resolve(cwd, ".env"));
  const dotEnv = envFile ? parseDotEnv(envFile) : {};

  const devConfig =
    env.NODE_ENV === "development" ? readDevConfig(resolve(cwd, "dev.config.json")) : {};

  // Per-field resolution with explicit precedence.
  const raw = {
    relayUrl: pick(env.RELAY_URL, dotEnv.RELAY_URL, devConfig.relayUrl),
    relayToken: pick(env.RELAY_TOKEN, dotEnv.RELAY_TOKEN, devConfig.relayToken),
    forgeUserId: pick(env.FORGE_USER_ID, dotEnv.FORGE_USER_ID, devConfig.forgeUserId),
    forgeApiKey: pick(env.FORGE_API_KEY, dotEnv.FORGE_API_KEY, devConfig.forgeApiKey),
    forgeApiBaseUrl: pick(
      env.FORGE_API_BASE_URL,
      dotEnv.FORGE_API_BASE_URL,
      devConfig.forgeApiBaseUrl,
    ),
    requestTimeoutMs: pick(
      env.RELAY_TIMEOUT_MS,
      dotEnv.RELAY_TIMEOUT_MS,
      devConfig.requestTimeoutMs?.toString(),
    ),
    trace: pick(env.RELAY_TRACE, dotEnv.RELAY_TRACE, devConfig.trace?.toString()),
    changeLog: pick(env.CHANGE_LOG, dotEnv.CHANGE_LOG, devConfig.changeLog?.toString()),
    changeLogDir: pick(env.CHANGE_LOG_DIR, dotEnv.CHANGE_LOG_DIR, devConfig.changeLogDir),
    codexBin: pick(env.CODEX_BIN, dotEnv.CODEX_BIN, devConfig.codexBin),
    imageOutputDir: pick(env.IMAGE_GEN_OUTPUT_DIR, dotEnv.IMAGE_GEN_OUTPUT_DIR, devConfig.imageOutputDir),
    imageCodexModel: pick(env.IMAGE_GEN_CODEX_MODEL, dotEnv.IMAGE_GEN_CODEX_MODEL, devConfig.imageCodexModel),
    imageTimeoutMs: pick(env.IMAGE_GEN_TIMEOUT_MS, dotEnv.IMAGE_GEN_TIMEOUT_MS, devConfig.imageTimeoutMs?.toString()),
    foundryTools: pick(env.FOUNDRY_TOOLS, dotEnv.FOUNDRY_TOOLS, devConfig.foundryTools),
    toolStats: pick(env.TOOL_STATS, dotEnv.TOOL_STATS, devConfig.toolStats?.toString()),
    toolStatsFile: pick(env.TOOL_STATS_FILE, dotEnv.TOOL_STATS_FILE, devConfig.toolStatsFile),
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid MCP server configuration. Fix these (via .env or environment):\n${issues}`,
    );
  }
  const { changeLog, changeLogDir, codexBin, imageOutputDir, imageCodexModel, imageTimeoutMs, foundryTools, toolStats, toolStatsFile, ...rest } = parsed.data;
  return {
    ...rest,
    toolGroups: parseToolGroups(foundryTools),
    toolStatsFile: toolStats ? (toolStatsFile ?? join(defaultStateDir(env), "tool-stats.jsonl")) : null,
    changeLogFile: changeLog ? join(changeLogDir ?? defaultStateDir(env), "changes.jsonl") : null,
    imageGen: {
      codexBin,
      outputDir: imageOutputDir ?? join(defaultStateDir(env), "generated-images"),
      model: imageCodexModel,
      timeoutMs: imageTimeoutMs,
    },
  };
}

interface DevConfig {
  relayUrl?: string;
  relayToken?: string;
  forgeUserId?: string;
  forgeApiKey?: string;
  forgeApiBaseUrl?: string;
  requestTimeoutMs?: number;
  trace?: boolean;
  changeLog?: boolean;
  changeLogDir?: string;
  codexBin?: string;
  imageOutputDir?: string;
  imageCodexModel?: string;
  imageTimeoutMs?: number;
  foundryTools?: string;
  toolStats?: boolean;
  toolStatsFile?: string;
}

function readDevConfig(path: string): DevConfig {
  const text = readIfExists(path);
  if (!text) return {};
  try {
    return JSON.parse(text) as DevConfig;
  } catch (e) {
    throw new Error(`Failed to parse ${path}: ${(e as Error).message}`);
  }
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function pick(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}
