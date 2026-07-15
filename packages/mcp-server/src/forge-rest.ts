/**
 * Phase 2: the Forge direct REST client (live-api-plan §A4, forge-asset-manager.md).
 *
 * The Forge VTT exposes a REST API callable straight from Node.js — no browser,
 * no Foundry module, no relay round-trip. This client lets the MCP server do
 * asset operations (browse / upload / create-folder) against The Forge bucket
 * directly, which is useful for *pre-flight* checks (does this map already exist?)
 * before driving the live world through the relay.
 *
 * It is deliberately decoupled from the relay path: it depends only on `fetch`
 * (injectable so tests never touch the network) and the two credentials
 * (`FORGE_USER_ID` + `FORGE_API_KEY`) read in config.ts. Nothing here imports the
 * transport or the reliability pipeline.
 *
 * Endpoint shapes mirror the discovery notes in docs/forge-asset-manager.md.
 */

import { assetBaseName } from "@foundry-mcp-bridge/shared";

const DEFAULT_BASE_URL = "https://forge-vtt.com/api";
const DEFAULT_TIMEOUT_MS = 15_000;
export interface ForgeRestConfig {
  /** Forge user id — the prefix for asset paths and the browse endpoint. */
  userId: string;
  /** API key from the Foundry module settings / Forge account. */
  apiKey: string;
  /** Override the API base (default https://forge-vtt.com/api); handy for tests. */
  baseUrl?: string;
  /** Injectable fetch so tests never hit the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

export interface ForgeBrowseResult {
  files: string[];
  dirs: string[];
}

export interface ForgeUploadResult {
  path: string;
}

export interface ForgeFolderResult {
  success: boolean;
}

export interface ForgeBatchUploadEntry {
  filename: string;
  contentBase64: string;
  mimeType?: string;
}

export interface ForgeBatchUploadResult {
  filename: string;
  /** The asset's stored path — the real existing path for a skipped entry. */
  path: string;
  skipped?: boolean;
}

/** A failed Forge REST call (non-2xx, network error, or malformed response). */
export class ForgeRestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ForgeRestError";
  }
}

export class ForgeRestClient {
  private readonly userId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: ForgeRestConfig) {
    if (!config.userId) throw new Error("ForgeRestClient requires a userId");
    if (!config.apiKey) throw new Error("ForgeRestClient requires an apiKey");
    this.userId = config.userId;
    this.apiKey = config.apiKey;
    // Drop a trailing slash so path joins are predictable.
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** List files + sub-directories under `path` in The Forge bucket. */
  async browseAssets(input: { path: string }): Promise<ForgeBrowseResult> {
    // The Forge browse endpoint is POST /assets/browse with the path in the JSON
    // body, and it answers with object entries — files carry {name,path,url,size}
    // and dirs carry {name,path}. We surface the file's full CDN `url` (directly
    // embeddable, and `assetBaseName` extracts its basename for dedup) and the
    // dir's `name`.
    const body = await this.requestJson(`${this.baseUrl}/assets/browse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: input.path }),
    });
    return {
      files: asEntryArray(body, "files", ["url", "path"]),
      dirs: asEntryArray(body, "dirs", ["name", "path"]),
    };
  }

  /** Upload one base64 asset to `target`, returning the stored Forge path. */
  async uploadAsset(input: {
    target: string;
    filename: string;
    contentBase64: string;
    mimeType?: string;
  }): Promise<ForgeUploadResult> {
    const bytes = decodeBase64(input.contentBase64);
    const form = new FormData();
    // The upload endpoint keys off `path` = the full destination (dir + filename),
    // NOT a bare `target` directory. Omitting the filename makes The Forge 500 on
    // an undefined `.replace()`.
    const dest = input.target
      ? `${input.target.replace(/\/+$/, "")}/${input.filename}`
      : input.filename;
    form.append("path", dest);
    form.append(
      "file",
      new Blob([bytes], { type: input.mimeType ?? "application/octet-stream" }),
      input.filename,
    );
    const body = await this.requestJson(`${this.baseUrl}/assets/upload`, {
      method: "POST",
      body: form,
    });
    // Response is { success, path, url }; prefer the full CDN `url` (directly
    // usable), falling back to the relative `path`.
    const path = readString(body, "url") ?? readString(body, "path");
    if (!path) {
      throw new ForgeRestError("Forge upload returned no path", undefined, body);
    }
    return { path };
  }

  /**
   * Upload many assets to `target`. With `skipExisting`, pre-browses the target
   * and skips files already present (matched by basename, so Forge's absolute CDN
   * URLs compare correctly). A skipped entry reports the real existing path; an
   * in-batch duplicate reports the first uploaded path. The dedup contract matches
   * the relay `batch_upload_assets` tool exactly. Files upload sequentially so the
   * in-batch dedup sees earlier uploads.
   */
  async batchUploadAssets(input: {
    target: string;
    files: ForgeBatchUploadEntry[];
    skipExisting?: boolean;
  }): Promise<ForgeBatchUploadResult[]> {
    // basename -> the asset's actual stored path (absolute CDN URL on The Forge).
    const existing = new Map<string, string>();
    if (input.skipExisting) {
      const browse = await this.browseAssets({ path: input.target });
      for (const f of browse.files) existing.set(assetBaseName(f), f);
    }
    const results: ForgeBatchUploadResult[] = [];
    for (const entry of input.files) {
      const known = existing.get(assetBaseName(entry.filename));
      if (known !== undefined) {
        results.push({ filename: entry.filename, path: known, skipped: true });
        continue;
      }
      const { path } = await this.uploadAsset({
        target: input.target,
        filename: entry.filename,
        contentBase64: entry.contentBase64,
        mimeType: entry.mimeType,
      });
      // Only track under skipExisting — its dedup contract owns within-batch skips.
      if (input.skipExisting) existing.set(assetBaseName(entry.filename), path);
      results.push({ filename: entry.filename, path });
    }
    return results;
  }

  /** Create a folder at `path` in The Forge bucket (idempotent on The Forge). */
  async createFolder(input: { path: string }): Promise<ForgeFolderResult> {
    const url = `${this.baseUrl}/assets/new-folder`;
    const body = await this.requestJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: input.path }),
    });
    // The Forge returns { success: true }; treat a missing flag as success only
    // when the call itself was 2xx (requestJson already enforced that).
    const success = readBoolean(body, "success");
    return { success: success ?? true };
  }

  /** Shared request plumbing: auth header, timeout, status + JSON-shape checks. */
  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Build headers via Headers so any init.headers form (object / Headers /
    // [k,v][]) is preserved, then add auth — a plain object spread would silently
    // drop a Headers instance or tuple array.
    const headers = new Headers(init.headers);
    headers.set("Authorization", this.apiKey);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers,
      });
      // Read the body inside the timed region: clearing the timer before the read
      // would leave a stalled-body response (headers in, body hanging) unbounded.
      text = await res.text();
    } catch (e) {
      const reason = controller.signal.aborted
        ? `Forge request timed out after ${this.timeoutMs}ms`
        : `Forge request failed: ${(e as Error).message}`;
      throw new ForgeRestError(reason);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ForgeRestError(
        `Forge API ${res.status} ${res.statusText}`.trim(),
        res.status,
        safeJson(text) ?? text,
      );
    }
    const parsed = safeJson(text);
    if (parsed === undefined) {
      throw new ForgeRestError("Forge API returned non-JSON response", res.status, text);
    }
    return parsed;
  }
}

function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Extract a string list from a Forge listing array. Each entry is either a bare
 * string (legacy/tolerant) or an object; for objects the first present key in
 * `prefer` wins (e.g. ["url","path"] for files, ["name","path"] for dirs).
 */
function asEntryArray(body: unknown, key: string, prefer: string[]): string[] {
  const arr = asRecord(body)[key];
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    const rec = asRecord(item);
    for (const p of prefer) {
      const v = rec[p];
      if (typeof v === "string") {
        out.push(v);
        break;
      }
    }
  }
  return out;
}

function readString(body: unknown, key: string): string | undefined {
  const v = asRecord(body)[key];
  return typeof v === "string" ? v : undefined;
}

function readBoolean(body: unknown, key: string): boolean | undefined {
  const v = asRecord(body)[key];
  return typeof v === "boolean" ? v : undefined;
}
