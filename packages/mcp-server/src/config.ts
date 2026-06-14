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
import { resolve } from "node:path";
import { z } from "zod";

export interface ServerConfig {
  /** WebSocket URL of the relay the Foundry module connects to. */
  relayUrl: string;
  /** Shared secret; must match the Foundry module's relay token if set. */
  relayToken?: string;
  /** Per-command transport timeout (ms). */
  requestTimeoutMs: number;
}

const ConfigSchema = z.object({
  relayUrl: z
    .string({ required_error: "relayUrl is required (set RELAY_URL)" })
    .min(1, "relayUrl must not be empty (set RELAY_URL)"),
  relayToken: z.string().min(1).optional(),
  requestTimeoutMs: z.coerce.number().int().positive().default(10_000),
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
    requestTimeoutMs: pick(
      env.RELAY_TIMEOUT_MS,
      dotEnv.RELAY_TIMEOUT_MS,
      devConfig.requestTimeoutMs?.toString(),
    ),
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
  return parsed.data;
}

interface DevConfig {
  relayUrl?: string;
  relayToken?: string;
  requestTimeoutMs?: number;
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
