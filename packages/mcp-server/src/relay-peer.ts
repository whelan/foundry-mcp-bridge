/**
 * Multi-process relay sharing. Only one process can bind RELAY_URL's port, so
 * every other MCP server process (a second Claude Code session, Codex, ...)
 * connects to the owning relay as a *peer* (`?role=peer`) and has its envelopes
 * forwarded to the single Foundry module connection.
 *
 * - {@link PeerRelayTransport}: Node client for peer mode, reconnecting on drop.
 * - {@link AutoRelayTransport}: binds the port if it can (owner), else falls back
 *   to peer mode; when the owner goes away it tries to take the port over.
 */

import { WebSocket } from "ws";
import { err, type CommandEnvelope, type CommandResult } from "@foundry-mcp-bridge/shared";
import { RelayServer } from "./relay-server.js";
import {
  PendingRequests,
  TimeoutError,
  withTimeout,
  type RelayTransport,
  type RequestOptions,
} from "./relay-transport.js";

type Log = (level: "info" | "warn" | "error", message: string) => void;

export function peerUrl(url: string, token?: string): string {
  const u = new URL(url);
  u.searchParams.set("role", "peer");
  if (token !== undefined) u.searchParams.set("token", token);
  return u.toString();
}

export interface PeerRelayTransportOptions {
  url: string;
  token?: string;
  defaultTimeoutMs: number;
  /** Delay before reconnecting after a drop (default 500ms). */
  reconnectDelayMs?: number;
  log?: Log;
  /**
   * Called after the connection drops (before reconnecting). Returning true
   * means the caller took over (e.g. promoted to owner) — don't reconnect.
   */
  onDrop?: () => Promise<boolean> | boolean;
}

export class PeerRelayTransport implements RelayTransport {
  private socket: WebSocket | null = null;
  private open = false;
  private closed = false;
  private openWaiters: Array<() => void> = [];
  private readonly pending = new PendingRequests();
  private readonly log: Log;
  private readonly url: string;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PeerRelayTransportOptions) {
    this.log = options.log ?? (() => {});
    this.url = peerUrl(options.url, options.token);
    this.connect();
  }

  /** Resolves once connected (or rejects after `timeoutMs`). */
  connected(timeoutMs = this.options.defaultTimeoutMs): Promise<void> {
    return this.waitOpen(timeoutMs);
  }

  private connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.log("info", "connected to relay as peer");
      for (const wake of this.openWaiters.splice(0)) wake();
    });
    socket.on("message", (data) => this.pending.settle(data.toString()));
    socket.on("error", (e) => this.log("warn", `peer socket error: ${(e as Error).message}`));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      const wasOpen = this.open;
      this.open = false;
      this.socket = null;
      if (wasOpen) this.log("warn", "peer connection to relay lost");
      this.pending.failAll((id) => err(id, "INTERNAL", "relay connection lost"));
      if (!this.closed) void this.handleDrop();
    });
  }

  private async handleDrop(): Promise<void> {
    let takenOver = false;
    try {
      takenOver = (await this.options.onDrop?.()) ?? false;
    } catch {
      takenOver = false;
    }
    if (takenOver || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectDelayMs ?? 500);
    this.reconnectTimer.unref?.();
  }

  private waitOpen(timeoutMs: number): Promise<void> {
    if (this.open) return Promise.resolve();
    let resolver!: () => void;
    const wait = new Promise<void>((resolve) => {
      resolver = resolve;
      this.openWaiters.push(resolver);
    });
    return withTimeout(wait, timeoutMs).catch(() => {
      const i = this.openWaiters.indexOf(resolver);
      if (i >= 0) this.openWaiters.splice(i, 1);
      throw new TimeoutError("not connected to the relay");
    });
  }

  async request(envelope: CommandEnvelope, opts?: RequestOptions): Promise<CommandResult> {
    if (this.closed) return err(envelope.id, "INTERNAL", "relay transport closed");
    const timeoutMs = opts?.timeoutMs ?? this.options.defaultTimeoutMs;
    await this.waitOpen(timeoutMs);
    const socket = this.socket;
    if (!socket || !this.open) return err(envelope.id, "INTERNAL", "relay connection lost");
    return this.pending.awaitResult(envelope.id, timeoutMs, () =>
      socket.send(JSON.stringify(envelope)),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pending.failAll((id) => err(id, "INTERNAL", "relay transport closed"));
    for (const wake of this.openWaiters.splice(0)) wake();
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }
}

export interface AutoRelayTransportOptions {
  url: string;
  token?: string;
  defaultTimeoutMs: number;
  reconnectDelayMs?: number;
  log?: Log;
}

function isAddrInUse(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}

/**
 * Owner-or-peer transport. `start()` tries to bind the relay port; on
 * EADDRINUSE it connects to the existing owner (another MCP process or the
 * standalone hub) as a peer. When a peer loses its owner it tries to bind the
 * port itself (promotion), and otherwise reconnects as a peer.
 */
export class AutoRelayTransport implements RelayTransport {
  private current: RelayServer | PeerRelayTransport | null = null;
  private closed = false;
  private readonly log: Log;

  constructor(private readonly options: AutoRelayTransportOptions) {
    this.log = options.log ?? (() => {});
  }

  get mode(): "owner" | "peer" | "none" {
    if (this.current instanceof RelayServer) return "owner";
    if (this.current instanceof PeerRelayTransport) return "peer";
    return "none";
  }

  /** Port bound when owner (test convenience). */
  address(): number | undefined {
    return this.current instanceof RelayServer ? this.current.address() : undefined;
  }

  async start(): Promise<"owner" | "peer"> {
    if (await this.tryOwn()) return "owner";
    this.log("info", `relay port in use; joining existing relay at ${this.options.url} as peer`);
    this.current = new PeerRelayTransport({
      url: this.options.url,
      token: this.options.token,
      defaultTimeoutMs: this.options.defaultTimeoutMs,
      reconnectDelayMs: this.options.reconnectDelayMs,
      log: this.log,
      onDrop: () => this.promote(),
    });
    return "peer";
  }

  /** Try to bind the port; true on success. Rethrows non-EADDRINUSE errors. */
  private async tryOwn(): Promise<boolean> {
    const server = new RelayServer({
      url: this.options.url,
      token: this.options.token,
      defaultTimeoutMs: this.options.defaultTimeoutMs,
      log: this.log,
    });
    try {
      await server.listening();
    } catch (e) {
      server.close();
      if (isAddrInUse(e)) return false;
      throw e;
    }
    if (this.closed) {
      server.close();
      return false;
    }
    this.current = server;
    return true;
  }

  private async promote(): Promise<boolean> {
    if (this.closed) return false;
    const peer = this.current;
    let owned = false;
    try {
      owned = await this.tryOwn();
    } catch (e) {
      this.log("warn", `relay promotion failed: ${(e as Error).message}`);
      return false;
    }
    if (!owned) return false;
    this.log("info", "previous relay owner gone; now hosting the relay");
    if (peer instanceof PeerRelayTransport) peer.close();
    return true;
  }

  request(envelope: CommandEnvelope, opts?: RequestOptions): Promise<CommandResult> {
    if (!this.current) {
      return Promise.resolve(err(envelope.id, "INTERNAL", "relay transport not started"));
    }
    return this.current.request(envelope, opts);
  }

  close(): void {
    this.closed = true;
    this.current?.close();
    this.current = null;
  }
}
