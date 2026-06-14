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
}

export class RelayClient {
  private socket: WebSocketLike | null = null;
  private readonly log: NonNullable<RelayClientOptions["log"]>;

  constructor(private readonly options: RelayClientOptions) {
    this.log = options.log ?? (() => {});
  }

  connect(): void {
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => this.log("info", `relay connected: ${this.options.url}`);
    socket.onerror = () => this.log("error", "relay socket error");
    socket.onclose = () => this.log("warn", "relay socket closed");
    socket.onmessage = (ev) => {
      void this.handleMessage(ev.data);
    };
  }

  disconnect(): void {
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
