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
  private clientWaiters: Array<() => void> = [];
  private readonly pending = new PendingRequests();

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
  }

  /** Resolves once the server is listening (test convenience). */
  listening(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.wss.address()) return resolve(this.address());
      this.wss.once("listening", () => resolve(this.address()));
      this.wss.once("error", reject);
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

    // Latest GM connection wins; drop any previous one.
    if (this.client && this.client !== socket) this.client.close(1000, "superseded");
    this.client = socket;
    this.log("info", "Foundry module connected");
    for (const wake of this.clientWaiters.splice(0)) wake();

    socket.on("message", (data) => this.pending.settle(data.toString()));
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
    });
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
    this.client?.close();
    this.client = null;
    this.wss.close();
  }
}
