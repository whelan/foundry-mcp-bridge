/**
 * WebSocket relay hosted *by* the MCP server. The Foundry module (running in the
 * GM's browser, locally or on The Forge) connects outbound to this endpoint;
 * the reliability pipeline sends {@link CommandEnvelope}s to the connected
 * module and awaits {@link CommandResult}s correlated by envelope id.
 *
 * Implements {@link RelayTransport}, so the pipeline and tools are identical
 * whether driven by this server, the external-hub client transport, or the mock.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { err, type CommandEnvelope, type CommandResult } from "@foundry-mcp-bridge/shared";
import {
  PendingRequests,
  TimeoutError,
  withTimeout,
  type RelayTransport,
  type RequestOptions,
} from "./relay-transport.js";

export interface RelayServerOptions {
  /** Endpoint the module connects to, e.g. ws://localhost:8787. */
  url: string;
  /** Shared secret; connections must present ?token=… when set. */
  token?: string;
  defaultTimeoutMs: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

interface Endpoint {
  port: number;
  host: string;
  path: string;
}

function parseEndpoint(url: string): Endpoint {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;
  return { port, host: u.hostname || "localhost", path: u.pathname || "/" };
}

export class RelayServer implements RelayTransport {
  private readonly wss: WebSocketServer;
  private readonly endpoint: Endpoint;
  private readonly token?: string;
  private readonly defaultTimeoutMs: number;
  private readonly log: NonNullable<RelayServerOptions["log"]>;

  private client: WebSocket | null = null;
  /** Upstream MCP processes (role=peer) sharing this relay's module connection. */
  private readonly peers = new Set<WebSocket>();
  /** In-flight peer requests: envelope id -> originating peer + cleanup timer. */
  private readonly peerRequests = new Map<string, { peer: WebSocket; timer: NodeJS.Timeout }>();
  private listenError: Error | null = null;
  private clientWaiters: Array<() => void> = [];
  private readonly pending = new PendingRequests();
  private closed = false;

  constructor(options: RelayServerOptions) {
    this.endpoint = parseEndpoint(options.url);
    this.token = options.token;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.log = options.log ?? (() => {});

    this.wss = new WebSocketServer({
      host: this.endpoint.host,
      port: this.endpoint.port,
      path: this.endpoint.path === "/" ? undefined : this.endpoint.path,
    });
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req.url));
    // `ws` objects are plain EventEmitters: an "error" with no listener throws
    // synchronously and takes the whole process down with it. A Mac sleep/wake
    // cycle (or any transient network blip) is exactly the kind of thing that
    // delivers a listen-socket error (e.g. a stale bind on wake), so this must
    // be handled, not left to the default EventEmitter behavior.
    this.wss.on("error", (e) => {
      this.listenError = e as Error;
      // EADDRINUSE is an expected outcome when another process owns the port
      // (callers fall back to peer mode); surface it via listening() only.
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") return;
      this.log("error", `relay listen socket error: ${(e as Error).message}`);
    });
  }

  /** Resolves once the server is listening (test convenience). */
  listening(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.listenError) return reject(this.listenError);
      if (this.wss.address()) return resolve(this.address());
      const onError = (e: Error) => reject(e);
      this.wss.once("error", onError);
      this.wss.once("listening", () => {
        this.wss.off("error", onError);
        resolve(this.address());
      });
    });
  }

  /** The actually-bound port (useful when the configured port was 0). */
  address(): number {
    const addr = this.wss.address();
    return typeof addr === "object" && addr ? addr.port : this.endpoint.port;
  }

  private onConnection(socket: WebSocket, reqUrl: string | undefined): void {
    if (this.token !== undefined) {
      const presented = new URL(reqUrl ?? "", "ws://placeholder").searchParams.get("token");
      if (presented !== this.token) {
        this.log("warn", "rejected relay connection: bad token");
        socket.close(1008, "invalid token");
        return;
      }
    }

    const params = new URL(reqUrl ?? "", "ws://placeholder").searchParams;
    if (params.get("role") === "peer") return this.onPeer(socket);

    // Latest GM connection wins; drop any previous one.
    if (this.client && this.client !== socket) this.client.close(1000, "superseded");
    this.client = socket;
    this.log("info", "Foundry module connected");
    for (const wake of this.clientWaiters.splice(0)) wake();

    socket.on("message", (data) => this.onModuleMessage(data.toString()));
    // Same reasoning as the wss-level handler above: a sleep/wake network
    // reset typically delivers an "error" (ECONNRESET/EPIPE/ENETDOWN) to the
    // client socket, sometimes before its "close". Without this listener that
    // error is uncaught and crashes the MCP server process — which is why a
    // sleep cycle looked like both the foundry and forge tools disconnecting
    // at once (they're served from the same process). The existing "close"
    // handler below still runs afterwards and does the actual cleanup.
    socket.on("error", (e) =>
      this.log("warn", `Foundry module socket error: ${(e as Error).message}`),
    );
    socket.on("close", () => {
      // Ignore a superseded/old socket closing — only the active client dropping
      // should fail in-flight requests (which were sent to that client).
      if (this.client !== socket) return;
      this.client = null;
      this.log("warn", "Foundry module disconnected");
      // Fail in-flight requests fast instead of waiting out their timeouts.
      this.pending.failAll((id) =>
        err(id, "INTERNAL", "Foundry module disconnected before responding"),
      );
      this.failPeerRequests("Foundry module disconnected before responding");
    });
  }

  /** Route a module result to the peer that asked, else to our own pending map. */
  private onModuleMessage(raw: string): void {
    let id: unknown;
    try {
      id = (JSON.parse(raw) as { id?: unknown }).id;
    } catch {
      return;
    }
    const entry = typeof id === "string" ? this.peerRequests.get(id) : undefined;
    if (entry && typeof id === "string") {
      this.peerRequests.delete(id);
      clearTimeout(entry.timer);
      if (entry.peer.readyState === entry.peer.OPEN) entry.peer.send(raw);
      return;
    }
    this.pending.settle(raw);
  }

  private onPeer(socket: WebSocket): void {
    this.peers.add(socket);
    this.log("info", "MCP peer connected");
    socket.on("message", (data) => void this.onPeerMessage(socket, data.toString()));
    socket.on("error", (e) => this.log("warn", `MCP peer socket error: ${(e as Error).message}`));
    socket.on("close", () => {
      this.peers.delete(socket);
      for (const [id, entry] of this.peerRequests) {
        if (entry.peer === socket) {
          clearTimeout(entry.timer);
          this.peerRequests.delete(id);
        }
      }
      this.log("info", "MCP peer disconnected");
    });
  }

  private sendToPeer(peer: WebSocket, result: CommandResult): void {
    if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(result));
  }

  private async onPeerMessage(peer: WebSocket, raw: string): Promise<void> {
    let envelope: { id?: unknown };
    try {
      envelope = JSON.parse(raw) as { id?: unknown };
    } catch {
      return;
    }
    const id = envelope.id;
    if (typeof id !== "string" || id.length === 0) return;
    try {
      await this.waitForClient(this.defaultTimeoutMs);
    } catch {
      return this.sendToPeer(peer, err(id, "TIMEOUT", "no Foundry module connected to the relay"));
    }
    const client = this.client;
    if (!client || this.closed || !this.peers.has(peer)) {
      return this.sendToPeer(peer, err(id, "INTERNAL", "relay unavailable"));
    }
    // Ids are randomUUIDs, so they are globally unique across peers. The timer
    // only garbage-collects a mapping the module never answers; the peer's own
    // request timeout is authoritative.
    const timer = setTimeout(() => this.peerRequests.delete(id), this.defaultTimeoutMs * 2);
    timer.unref?.();
    this.peerRequests.set(id, { peer, timer });
    client.send(raw);
  }

  private failPeerRequests(message: string): void {
    const entries = [...this.peerRequests.entries()];
    this.peerRequests.clear();
    for (const [id, entry] of entries) {
      clearTimeout(entry.timer);
      this.sendToPeer(entry.peer, err(id, "INTERNAL", message));
    }
  }

  private waitForClient(timeoutMs: number): Promise<void> {
    if (this.client) return Promise.resolve();
    let resolver!: () => void;
    const wait = new Promise<void>((resolve) => {
      resolver = resolve;
      this.clientWaiters.push(resolver);
    });
    return withTimeout(wait, timeoutMs).catch(() => {
      // Drop our waiter so it doesn't leak (and fire on a later connection).
      const i = this.clientWaiters.indexOf(resolver);
      if (i >= 0) this.clientWaiters.splice(i, 1);
      throw new TimeoutError("no Foundry module connected to the relay");
    });
  }

  async request(envelope: CommandEnvelope, opts?: RequestOptions): Promise<CommandResult> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    await this.waitForClient(timeoutMs);
    const client = this.client;
    if (!client) throw new TimeoutError("no Foundry module connected to the relay");

    return this.pending.awaitResult(envelope.id, timeoutMs, () =>
      client.send(JSON.stringify(envelope)),
    );
  }

  close(): void {
    if (this.closed) return; // idempotent
    this.closed = true;
    this.client?.close();
    this.client = null;
    // The socket's own close handler won't drain now (client is null), so do it
    // here: fail in-flight requests and wake any waiters so callers don't hang
    // until their timeouts on an intentional shutdown.
    this.pending.failAll((id) => err(id, "INTERNAL", "relay server closed"));
    this.failPeerRequests("relay server closed");
    for (const peer of this.peers) peer.close(1001, "relay closing");
    this.peers.clear();
    for (const wake of this.clientWaiters.splice(0)) wake();
    this.wss.close();
  }
}
