/**
 * WebSocket relay client. The module connects out to a configured relay; each
 * inbound message is a {@link CommandEnvelope}, executed via the
 * {@link executeCommand} core and answered with a {@link CommandResult}.
 *
 * The WebSocket is injected via a factory so the client is testable with a fake
 * socket (no browser, no real Foundry).
 */

import {
  CommandEnvelope,
  type CommandResult,
  err,
} from "@foundry-mcp-bridge/shared";
import {
  executeCommand,
  type ExecutorContext,
  type FoundryDocumentApi,
} from "./protocol-executor.js";

/** Minimal browser-WebSocket-compatible surface. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onclose: ((this: unknown, ev: unknown) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface RelayClientOptions {
  url: string;
  api: FoundryDocumentApi;
  context: ExecutorContext;
  createSocket: WebSocketFactory;
  /** Optional logger; defaults to no-op. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** Auto-reconnect on an unexpected close. Default: true. */
  reconnect?: boolean;
  /** First backoff delay; doubles each attempt. Default: 1000ms. */
  reconnectBaseDelayMs?: number;
  /** Backoff cap. Default: 30000ms. */
  reconnectMaxDelayMs?: number;
  /** Injectable timer (testing); defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class RelayClient {
  private socket: WebSocketLike | null = null;
  private readonly log: NonNullable<RelayClientOptions["log"]>;
  /** Set by disconnect() so a deliberate close doesn't trigger a reconnect. */
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectHandle: unknown = null;
  private readonly reconnectEnabled: boolean;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly setTimer: NonNullable<RelayClientOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<RelayClientOptions["clearTimer"]>;

  constructor(private readonly options: RelayClientOptions) {
    this.log = options.log ?? (() => {});
    this.reconnectEnabled = options.reconnect ?? true;
    this.baseDelay = options.reconnectBaseDelayMs ?? 1000;
    this.maxDelay = options.reconnectMaxDelayMs ?? 30000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  connect(): void {
    this.intentionalClose = false;
    this.openSocket();
  }

  private openSocket(): void {
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempts = 0; // a clean open resets the backoff
      this.log("info", `relay connected: ${this.options.url}`);
    };
    socket.onerror = () => this.log("error", "relay socket error");
    socket.onclose = () => {
      this.log("warn", "relay socket closed");
      this.scheduleReconnect();
    };
    socket.onmessage = (ev) => {
      void this.handleMessage(ev.data);
    };
  }

  /** Schedule a reconnect with exponential backoff, unless closed on purpose. */
  private scheduleReconnect(): void {
    if (this.intentionalClose || !this.reconnectEnabled) return;
    const delay = Math.min(this.baseDelay * 2 ** this.reconnectAttempts, this.maxDelay);
    this.reconnectAttempts += 1;
    this.log("info", `relay reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectHandle = this.setTimer(() => {
      this.reconnectHandle = null;
      if (this.intentionalClose) return;
      this.openSocket();
    }, delay);
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectHandle != null) {
      this.clearTimer(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /**
   * Parse, execute and answer a single raw message. Exposed for testing; also
   * used by the onmessage handler. Always attempts to send a structured result.
   */
  async handleMessage(raw: unknown): Promise<CommandResult> {
    let result: CommandResult;
    try {
      const json = typeof raw === "string" ? JSON.parse(raw) : raw;
      const parsed = CommandEnvelope.safeParse(json);
      if (!parsed.success) {
        const id = idFromUnknown(json) ?? "unknown";
        result = err(id, "VALIDATION", "invalid command envelope", parsed.error.format());
      } else {
        result = await executeCommand(parsed.data, this.options.api, this.options.context);
      }
    } catch (e) {
      result = err("unknown", "INTERNAL", (e as Error).message);
    }
    this.send(result);
    return result;
  }

  private send(result: CommandResult): void {
    try {
      this.socket?.send(JSON.stringify(result));
    } catch (e) {
      this.log("error", `failed to send result: ${(e as Error).message}`);
    }
  }
}

function idFromUnknown(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}
