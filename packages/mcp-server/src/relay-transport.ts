/**
 * Transport that carries a {@link CommandEnvelope} to the Foundry module and
 * awaits its {@link CommandResult}. The MCP server and the module both connect
 * to the relay hub (config.relayUrl); responses are correlated by envelope id.
 *
 * The pipeline (reliability.ts) depends only on the {@link RelayTransport}
 * interface, so it is tested against a mock-foundry-backed transport. The
 * WebSocket implementation here is typechecked but not exercised in CI.
 */

import {
  CommandResult,
  type CommandEnvelope,
} from "@foundry-mcp-bridge/shared";

export class TimeoutError extends Error {
  constructor(message = "request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface RequestOptions {
  timeoutMs?: number;
}

export interface RelayTransport {
  request(envelope: CommandEnvelope, opts?: RequestOptions): Promise<CommandResult>;
  close(): void;
}

/**
 * Correlates outbound envelopes with their results by id, with per-request
 * timeouts. Shared by both transports so the correlation logic lives in one
 * place (and a timed-out entry never leaks).
 */
export class PendingRequests {
  private readonly map = new Map<string, (result: CommandResult) => void>();

  /** Parse a raw inbound message and resolve the matching pending request. */
  settle(raw: unknown): void {
    let json: unknown;
    try {
      json = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    const parsed = CommandResult.safeParse(json);
    if (!parsed.success) return;
    const resolve = this.map.get(parsed.data.id);
    if (resolve) {
      this.map.delete(parsed.data.id);
      resolve(parsed.data);
    }
  }

  /** Register request `id`, run `send`, then await its result within `timeoutMs`. */
  async awaitResult(
    id: string,
    timeoutMs: number,
    send: () => void,
  ): Promise<CommandResult> {
    const response = new Promise<CommandResult>((resolve) => {
      this.map.set(id, resolve);
      send();
    });
    try {
      return await withTimeout(response, timeoutMs);
    } finally {
      this.map.delete(id);
    }
  }

  /**
   * Settle every outstanding request with a synthesized result — used on
   * disconnect so callers fail fast instead of waiting out their timeouts.
   */
  failAll(makeResult: (id: string) => CommandResult): void {
    const entries = [...this.map.entries()];
    this.map.clear();
    for (const [id, resolve] of entries) resolve(makeResult(id));
  }
}

/** Minimal browser/Node WebSocket surface used by the client transport. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (ev: { data?: unknown }) => void): void;
}

export type WsFactory = (url: string) => WsLike;

const defaultWsFactory: WsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (!Ctor) {
    throw new Error(
      "No global WebSocket available. Use Node >= 20 or provide a WsFactory.",
    );
  }
  return new Ctor(url);
};

export interface WebSocketRelayTransportOptions {
  url: string;
  defaultTimeoutMs: number;
  createSocket?: WsFactory;
}

export class WebSocketRelayTransport implements RelayTransport {
  private readonly socket: WsLike;
  private readonly defaultTimeoutMs: number;
  private readonly ready: Promise<void>;
  private readonly pending = new PendingRequests();
  private readonly onMessage = (ev: { data?: unknown }) => this.pending.settle(ev.data);

  constructor(options: WebSocketRelayTransportOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    const factory = options.createSocket ?? defaultWsFactory;
    this.socket = factory(options.url);
    this.ready = new Promise<void>((resolve) => {
      this.socket.addEventListener("open", () => resolve());
    });
    this.socket.addEventListener("message", this.onMessage);
  }

  async request(envelope: CommandEnvelope, opts?: RequestOptions): Promise<CommandResult> {
    await this.ready;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return this.pending.awaitResult(envelope.id, timeoutMs, () =>
      this.socket.send(JSON.stringify(envelope)),
    );
  }

  close(): void {
    this.socket.removeEventListener?.("message", this.onMessage);
    this.pending.failAll((id) => ({
      id,
      ok: false,
      error: { code: "INTERNAL", message: "relay transport closed" },
    }));
    this.socket.close();
  }
}
