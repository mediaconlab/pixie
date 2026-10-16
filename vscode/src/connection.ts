/**
 * WebSocket client for the Pixie brain. Independent of the vscode API so it can be unit-tested with a
 * fake socket. Implements PROTOCOL.md §2: hello first, plain-text ping every 30 s, exponential reconnect
 * backoff 1 s → 30 s, and an offline queue (cap 100, drop oldest).
 */
import { BoundedQueue, backoffDelay, Envelope, HelloData, makeEnvelope, parseFrame } from "./protocol";

/** The subset of a `ws` WebSocket that we use. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", cb: (code: number, reason: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "unexpected-response", cb: (req: unknown, res: { statusCode?: number }) => void): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export type ConnectionState = "idle" | "connecting" | "open" | "closed";

export interface ConnectionEvents {
  onState?(state: ConnectionState): void;
  onEnvelope?(env: Envelope): void;
  onUnauthorized?(): void;
  onLog?(msg: string): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

export const PING_INTERVAL_MS = 30_000;
/** If nothing (not even a pong) arrives for this long, the socket is considered dead. */
export const DEAD_AFTER_MS = 75_000;
const OPEN = 1;

export interface ConnectionOptions {
  wsUrl: string;
  token: string;
  hello: HelloData;
  factory: SocketFactory;
  events?: ConnectionEvents;
  timers?: Timers;
  jitter?: number;
}

export class Connection {
  private socket: SocketLike | null = null;
  private queue = new BoundedQueue<string>(100);
  private attempt = 0;
  private reconnectTimer: unknown;
  private pingTimer: unknown;
  private lastRx = 0;
  private stopped = true;
  private _state: ConnectionState = "idle";
  private readonly timers: Timers;

  constructor(private readonly opts: ConnectionOptions) {
    this.timers = opts.timers ?? realTimers;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get queued(): number {
    return this.queue.size;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.close(1000, "client stop");
      } catch {
        /* ignore */
      }
    }
    this.setState("closed");
  }

  /** Reconnect immediately (e.g. the user clicked "retry"). */
  reconnectNow(): void {
    if (this.stopped) return this.start();
    if (this._state === "open" || this._state === "connecting") return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.attempt = 0;
    this.connect();
  }

  /** Send an event; queued while offline. Returns the envelope id. */
  send<T>(type: string, data: T): string {
    const env = makeEnvelope(type, data, this.timers.now());
    const frame = JSON.stringify(env);
    if (this.socket && this._state === "open" && this.socket.readyState === OPEN) {
      try {
        this.socket.send(frame);
        return env.id;
      } catch {
        /* fall through to queue */
      }
    }
    this.queue.push(frame);
    return env.id;
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    this.opts.events?.onState?.(s);
  }

  private log(msg: string): void {
    this.opts.events?.onLog?.(msg);
  }

  private clearTimers(): void {
    this.timers.clearTimeout(this.reconnectTimer);
    this.timers.clearInterval(this.pingTimer);
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    let sock: SocketLike;
    try {
      sock = this.opts.factory(this.opts.wsUrl, { Authorization: `Bearer ${this.opts.token}` });
    } catch (e) {
      this.log(`connect failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    let unauthorized = false;

    sock.on("open", () => {
      if (this.socket !== sock) return;
      this.attempt = 0;
      this.lastRx = this.timers.now();
      // hello must be the first frame after connect.
      sock.send(JSON.stringify(makeEnvelope("hello", this.opts.hello, this.timers.now())));
      this.setState("open");
      for (const frame of this.queue.drain()) {
        try {
          sock.send(frame);
        } catch {
          this.queue.push(frame);
        }
      }
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = this.timers.setInterval(() => this.heartbeat(sock), PING_INTERVAL_MS);
    });

    sock.on("message", (data: unknown) => {
      if (this.socket !== sock) return;
      this.lastRx = this.timers.now();
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const parsed = parseFrame(text);
      if (parsed === null || parsed === "pong") return;
      this.opts.events?.onEnvelope?.(parsed);
    });

    sock.on("unexpected-response", (_req, res) => {
      if (res?.statusCode === 401 || res?.statusCode === 403) {
        unauthorized = true;
      }
      this.log(`websocket upgrade rejected: HTTP ${res?.statusCode ?? "?"}`);
    });

    sock.on("error", (err: Error) => {
      this.log(`websocket error: ${err.message}`);
    });

    sock.on("close", (code: number) => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
      this.log(`websocket closed (${code})`);
      if (unauthorized || code === 4401 || code === 4403) {
        this.stopped = true;
        this.setState("closed");
        this.opts.events?.onUnauthorized?.();
        return;
      }
      this.setState("closed");
      this.scheduleReconnect();
    });
  }

  private heartbeat(sock: SocketLike): void {
    if (this.socket !== sock) return;
    if (this.timers.now() - this.lastRx > DEAD_AFTER_MS) {
      this.log("no traffic from brain, reconnecting");
      try {
        if (sock.terminate) sock.terminate();
        else sock.close(4000, "dead");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      sock.send("ping");
    } catch {
      /* close handler will reconnect */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, this.opts.jitter ?? 0.2);
    this.attempt++;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
