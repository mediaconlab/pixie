/**
 * UserBrain — one SQLite-backed Durable Object per user.
 * Thin runtime shell around BrainCore: WebSocket Hibernation API, alarms, AI binding.
 */
import { DurableObject } from "cloudflare:workers";
import { WorkersAiBrainpower, type Brainpower } from "../ai";
import { listDevices, touchDevice } from "../db";
import type { Env } from "../env";
import { type DeviceKind, envelope, parseEnvelope } from "../protocol";
import { BrainCore, type DeviceConn } from "./core";

interface Attachment {
  deviceId: string;
  kind: DeviceKind;
  name: string;
  userId: string;
  lastTouch: number;
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

export class UserBrain extends DurableObject<Env> {
  private readonly core: BrainCore;
  private readonly ai: Brainpower;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ai = new WorkersAiBrainpower(env.AI as unknown as { run(m: string, i: Record<string, unknown>): Promise<unknown> }, {
      models: env.MODELS,
      visionModel: env.VISION_MODEL,
      embedModel: env.EMBED_MODEL,
    });
    this.core = new BrainCore({
      sql: ctx.storage.sql,
      ai: this.ai,
      devices: () => this.connections(),
      registeredDevices: async () => {
        const uid = this.userId();
        return uid ? (await listDevices(env.DB, uid)).map((d) => ({ id: d.id, kind: d.kind, name: d.name })) : [];
      },
      setAlarm: async (ts) => {
        if (ts == null) await ctx.storage.deleteAlarm();
        else {
          const cur = await ctx.storage.getAlarm();
          if (cur !== ts) await ctx.storage.setAlarm(ts);
        }
      },
    });
    // Keepalive without waking the DO from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private userId(): string | null {
    const rows = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'user_id'").toArray();
    if (!rows[0]) return null;
    try {
      return JSON.parse(rows[0].value) as string;
    } catch {
      return null;
    }
  }

  private setIdentity(userId: string, userName: string | null): void {
    if (this.userId() !== userId) {
      this.ctx.storage.sql.exec(
        "INSERT INTO kv (key, value) VALUES ('user_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(userId),
      );
    }
    this.core.setUserName(userName);
  }

  private connections(): DeviceConn[] {
    const out: DeviceConn[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      if (ws.readyState !== 1) continue; // OPEN
      out.push({ id: a.deviceId, kind: a.kind, name: a.name, send: (t) => ws.send(t) });
    }
    return out;
  }

  // ---- HTTP (from the Worker only) ---------------------------------------------------------

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const userId = req.headers.get("X-User-Id");
    if (userId) this.setIdentity(userId, decodeHeader(req.headers.get("X-User-Name")));

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected_websocket" }, 426);
      const deviceId = req.headers.get("X-Device-Id");
      const kind = req.headers.get("X-Device-Kind") as DeviceKind | null;
      if (!deviceId || !kind || !userId) return json({ error: "unauthorized" }, 401);
      // One socket per device: close older sockets of the same device.
      for (const ws of this.ctx.getWebSockets(deviceId)) {
        try {
          ws.close(4000, "replaced by a newer connection");
        } catch {
          /* already closed */
        }
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [deviceId, `kind:${kind}`]);
      const att: Attachment = { deviceId, kind, name: decodeHeader(req.headers.get("X-Device-Name")) ?? kind, userId, lastTouch: Date.now() };
      server.serializeAttachment(att);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/memory" && req.method === "GET") return json(this.core.memoryDump());
    if (url.pathname === "/memory" && req.method === "DELETE") {
      await this.core.serialize(async () => this.core.forget());
      return json({ ok: true });
    }
    if (url.pathname === "/online") return json({ online: [...new Set(this.connections().map((c) => c.id))] });
    if (url.pathname === "/learn" && req.method === "POST") return json(await this.core.learn());
    if (url.pathname === "/revoke" && req.method === "POST") {
      const { device_id } = (await req.json()) as { device_id: string };
      for (const ws of this.ctx.getWebSockets(device_id)) {
        try {
          ws.close(4001, "device revoked");
        } catch {
          /* ignore */
        }
      }
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  // ---- WebSocket Hibernation handlers ----------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) {
      ws.close(1008, "no identity");
      return;
    }
    if (message === "ping") {
      ws.send("pong");
      return;
    }
    const now = Date.now();
    if (now - a.lastTouch > TOUCH_INTERVAL_MS) {
      a.lastTouch = now;
      ws.serializeAttachment(a);
      this.ctx.waitUntil(touchDevice(this.env.DB, a.deviceId, now).catch(() => {}));
    }
    const parsed = parseEnvelope(message, now);
    if (!parsed.ok) {
      ws.send(envelope("error", { code: parsed.code, message: parsed.message }));
      return;
    }
    // The token's device kind is authoritative; ignore hello.kind mismatches.
    if (parsed.event.type === "hello" && parsed.event.data.name && parsed.event.data.name !== a.name) {
      a.name = parsed.event.data.name;
      ws.serializeAttachment(a);
    }
    await this.core.handleEvent(parsed.event, { deviceId: a.deviceId, kind: a.kind });
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* ignore */
    }
  }

  override async alarm(): Promise<void> {
    await this.core.alarm();
  }

  // ---- RPC (used by the Worker's scheduled handler) ------------------------------------------------

  async learn(userId: string): Promise<{ episodes: number; merged: number; preferences: number; contacts: number }> {
    this.setIdentity(userId, null);
    return this.core.learn();
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Names travel URL-encoded in internal headers (header values can't hold characters like ’). */
function decodeHeader(v: string | null): string | null {
  if (v == null) return null;
  try { return decodeURIComponent(v); } catch { return v; }
}
