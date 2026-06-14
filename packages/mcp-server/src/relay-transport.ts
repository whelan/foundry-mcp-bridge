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

/** Minimal browser/Node WebSocket surface used by the client transport. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
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
  private socket: WsLike;
  private readonly defaultTimeoutMs: number;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<
    string,
    { resolve: (r: CommandResult) => void; reject: (e: Error) => void }
  >();

  constructor(options: WebSocketRelayTransportOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    const factory = options.createSocket ?? defaultWsFactory;
    this.socket = factory(options.url);
    this.ready = new Promise<void>((resolve) => {
      this.socket.addEventListener("open", () => resolve());
    });
    this.socket.addEventListener("message", (ev) => this.onMessage(ev.data));
  }

  private onMessage(raw: unknown): void {
    const parsed = CommandResult.safeParse(
      typeof raw === "string" ? JSON.parse(raw) : raw,
    );
    if (!parsed.success) return;
    const entry = this.pending.get(parsed.data.id);
    if (entry) {
      this.pending.delete(parsed.data.id);
      entry.resolve(parsed.data);
    }
  }

  async request(envelope: CommandEnvelope, opts?: RequestOptions): Promise<CommandResult> {
    await this.ready;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const response = new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(envelope.id, { resolve, reject });
      this.socket.send(JSON.stringify(envelope));
    });
    try {
      return await withTimeout(response, timeoutMs);
    } finally {
      this.pending.delete(envelope.id);
    }
  }

  close(): void {
    this.socket.close();
  }
}
