import { describe, expect, it } from "vitest";
import { Connection, SocketLike, Timers } from "../src/connection";

type Handler = (...args: any[]) => void;

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  handlers: Record<string, Handler[]> = {};
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  on(event: string, cb: Handler): void {
    (this.handlers[event] ??= []).push(cb);
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", code, "");
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
}

class FakeTimers implements Timers {
  t = 0;
  seq = 0;
  list: { id: number; at: number; fn: () => void; every?: number }[] = [];
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.list.push({ id, at: this.t + ms, fn });
    return id;
  }
  setInterval(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.list.push({ id, at: this.t + ms, fn, every: ms });
    return id;
  }
  clearTimeout(h: unknown) {
    this.list = this.list.filter((x) => x.id !== h);
  }
  clearInterval(h: unknown) {
    this.clearTimeout(h);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.list.sort((a, b) => a.at - b.at);
      const n = this.list[0];
      if (!n || n.at > end) break;
      this.t = n.at;
      if (n.every) n.at += n.every;
      else this.list.shift();
      n.fn();
    }
    this.t = end;
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const envelopes: unknown[] = [];
  const states: string[] = [];
  let unauthorized = 0;
  const conn = new Connection({
    wsUrl: "wss://x.dev/v1/ws",
    token: "tok",
    hello: { kind: "ide", name: "VS Code", app_version: "1.0.0", capabilities: ["code"] },
    factory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    timers,
    jitter: 0,
    events: {
      onEnvelope: (e) => envelopes.push(e),
      onState: (s) => states.push(s),
      onUnauthorized: () => unauthorized++,
    },
  });
  return { conn, sockets, timers, envelopes, states, unauthorized: () => unauthorized };
}

describe("Connection", () => {
  it("sends the bearer header and hello first, then flushes the offline queue", () => {
    const { conn, sockets } = setup();
    conn.send("user.say", { text: "queued", via: "typed" });
    conn.start();
    expect(sockets[0].headers.Authorization).toBe("Bearer tok");
    sockets[0].open();
    const frames = sockets[0].sent.map((s) => JSON.parse(s));
    expect(frames[0]).toMatchObject({ v: 1, type: "hello", data: { kind: "ide", capabilities: ["code"] } });
    expect(frames[1]).toMatchObject({ type: "user.say", data: { text: "queued" } });
    expect(conn.queued).toBe(0);
  });

  it("caps the offline queue at 100, dropping the oldest", () => {
    const { conn, sockets } = setup();
    for (let i = 0; i < 120; i++) conn.send("user.say", { text: String(i), via: "typed" });
    expect(conn.queued).toBe(100);
    conn.start();
    sockets[0].open();
    const texts = sockets[0].sent.slice(1).map((s) => JSON.parse(s).data.text);
    expect(texts[0]).toBe("20");
    expect(texts).toHaveLength(100);
  });

  it("pings every 30 s with a plain text frame and ignores pong", () => {
    const { conn, sockets, timers, envelopes } = setup();
    conn.start();
    sockets[0].open();
    timers.advance(30000);
    expect(sockets[0].sent.at(-1)).toBe("ping");
    sockets[0].emit("message", Buffer.from("pong"), false);
    expect(envelopes).toHaveLength(0);
    sockets[0].emit("message", '{"v":1,"id":"b","ts":1,"type":"bot.perform","data":{"say":"hi"}}', false);
    expect(envelopes).toHaveLength(1);
  });

  it("reconnects with exponential backoff and resets after success", () => {
    const { conn, sockets, timers } = setup();
    conn.start();
    sockets[0].close(1006);
    timers.advance(999);
    expect(sockets).toHaveLength(1);
    timers.advance(1);
    expect(sockets).toHaveLength(2);
    sockets[1].close(1006);
    timers.advance(1999);
    expect(sockets).toHaveLength(2);
    timers.advance(1);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    sockets[2].close(1006);
    timers.advance(1000);
    expect(sockets).toHaveLength(4);
  });

  it("caps backoff at 30 s", () => {
    const { conn, sockets, timers } = setup();
    conn.start();
    for (let i = 0; i < 8; i++) {
      sockets.at(-1)!.close(1006);
      timers.advance(30000);
    }
    const before = sockets.length;
    sockets.at(-1)!.close(1006);
    timers.advance(29999);
    expect(sockets.length).toBe(before);
    timers.advance(1);
    expect(sockets.length).toBe(before + 1);
  });

  it("terminates a silent socket", () => {
    const { conn, sockets, timers } = setup();
    conn.start();
    sockets[0].open();
    timers.advance(90000);
    expect(sockets[0].closed).toBe(true);
  });

  it("stops and reports when the token is rejected", () => {
    const { conn, sockets, timers, unauthorized } = setup();
    conn.start();
    sockets[0].emit("unexpected-response", {}, { statusCode: 401 });
    sockets[0].close(1006);
    timers.advance(60000);
    expect(sockets).toHaveLength(1);
    expect(unauthorized()).toBe(1);
  });

  it("stop() prevents reconnects", () => {
    const { conn, sockets, timers } = setup();
    conn.start();
    sockets[0].open();
    conn.stop();
    timers.advance(60000);
    expect(sockets).toHaveLength(1);
  });
});
