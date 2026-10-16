/**
 * pixie-orchestrator — Worker entry: REST routes (PROTOCOL.md §1), WebSocket forwarding to the
 * per-user Durable Object, and the nightly learner cron.
 */
import { authenticate } from "./auth";
import { generateToken, hashToken } from "./auth";
import { createDevice, createOwner, createUser, deleteDevice, getOwnerId, listDevices, listUserIds, type DeviceWithUser } from "./db";
import type { Env } from "./env";
import { consumeCode, isClaimRateLimited, pairLink, recordFailedClaim, startPairing } from "./pairing";
import { BRAIN_VERSION, type DeviceKind } from "./protocol";
import { newId } from "./util";

export { UserBrain } from "./brain/UserBrain";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS } });
}

export function err(status: number, code: string, message?: string): Response {
  return json(message ? { error: code, message } : { error: code }, status);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const t = await req.text();
    if (!t) return {};
    const j = JSON.parse(t);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseDevice(x: unknown, allowed: DeviceKind[]): { kind: DeviceKind; name: string } | null {
  if (!x || typeof x !== "object") return null;
  const d = x as Record<string, unknown>;
  const kind = d.kind as DeviceKind;
  if (!allowed.includes(kind)) return null;
  const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 100) : kind;
  return { kind, name };
}

function brainStub(env: Env, userId: string) {
  return env.USER_BRAIN.get(env.USER_BRAIN.idFromName(userId));
}

/** Forward a request to the user's DO at an internal path. */
function toBrain(env: Env, dev: DeviceWithUser, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-User-Id", dev.user_id);
  headers.set("X-User-Name", encodeURIComponent(dev.user_name));
  headers.set("X-Device-Id", dev.id);
  headers.set("X-Device-Kind", dev.kind);
  return brainStub(env, dev.user_id).fetch(`https://brain${path}`, { ...init, headers });
}

async function withCors(r: Response): Promise<Response> {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

async function issueDevice(env: Env, userId: string, kind: DeviceKind, name: string, now: number) {
  const token = generateToken();
  const device_id = newId("dev");
  await createDevice(env.DB, { id: device_id, user_id: userId, kind, name, token_hash: await hashToken(token), created_at: now, last_seen: now });
  return { user_id: userId, device_id, token };
}

export async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const now = Date.now();

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (path === "/health" && method === "GET") return json({ ok: true, version: BRAIN_VERSION });

  if (path === "/v1/register" && method === "POST") {
    const body = await readJson(req);
    if (!body) return err(400, "bad_request", "invalid JSON");
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    const device = parseDevice(body.device, ["mac"]);
    if (!name) return err(400, "bad_request", "name required");
    if (!device) return err(400, "bad_request", "only device.kind \"mac\" may register");
    const userId = newId("usr");
    const isOwner = !(await getOwnerId(env.DB)) && (await createOwner(env.DB, { id: userId, name, created_at: now }));
    if (!isOwner) {
      if (env.ALLOW_SIGNUP !== "1") return err(403, "registration_closed");
      await createUser(env.DB, { id: userId, name, is_owner: 0, created_at: now });
    }
    return json(await issueDevice(env, userId, "mac", device.name, now));
  }

  if (path === "/v1/pair/claim" && method === "POST") {
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    if (await isClaimRateLimited(env.DB, ip, now)) return err(429, "rate_limited", "too many failed pairing attempts; try again later");
    const body = await readJson(req);
    if (!body) return err(400, "bad_request", "invalid JSON");
    const device = parseDevice(body.device, ["android", "ide"]);
    if (!device) return err(400, "bad_request", "device.kind must be \"android\" or \"ide\"");
    const code = typeof body.code === "string" ? body.code.trim() : typeof body.code === "number" ? String(body.code).padStart(6, "0") : "";
    const userId = await consumeCode(env.DB, code, now);
    if (!userId) {
      await recordFailedClaim(env.DB, ip, now);
      return err(404, "bad_code");
    }
    return json(await issueDevice(env, userId, device.kind, device.name, now));
  }

  // ---- authenticated routes ----
  const isWs = path === "/v1/ws";
  const dev = await authenticate(req, env.DB, { allowQuery: isWs, now, waitUntil: (p) => ctx.waitUntil(p) });
  const needsAuth = ["/v1/pair/start", "/v1/devices", "/v1/memory", "/v1/ws"].includes(path) || path.startsWith("/v1/devices/");
  if (needsAuth && !dev) return err(401, "unauthorized");

  if (dev) {
    if (isWs && method === "GET") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return err(426, "upgrade_required", "expected a WebSocket upgrade");
      const headers = new Headers(req.headers);
      headers.set("X-User-Id", dev.user_id);
      headers.set("X-User-Name", encodeURIComponent(dev.user_name));
      headers.set("X-Device-Id", dev.id);
      headers.set("X-Device-Kind", dev.kind);
      headers.set("X-Device-Name", encodeURIComponent(dev.name));
      return brainStub(env, dev.user_id).fetch(new Request("https://brain/ws", { method: "GET", headers }));
    }

    if (path === "/v1/pair/start" && method === "POST") {
      const { code, expires_at } = await startPairing(env.DB, dev.user_id, now);
      const base = `${url.protocol}//${url.host}`;
      return json({ code, expires_at, link: pairLink(base, code) });
    }

    if (path === "/v1/devices" && method === "GET") {
      const [rows, onlineRes] = await Promise.all([listDevices(env.DB, dev.user_id), toBrain(env, dev, "/online")]);
      const online = new Set(((await onlineRes.json()) as { online: string[] }).online ?? []);
      return json({ devices: rows.map((d) => ({ id: d.id, kind: d.kind, name: d.name, last_seen: d.last_seen, online: online.has(d.id) })) });
    }

    const m = path.match(/^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/);
    if (m && method === "DELETE") {
      const id = m[1]!;
      const ok = await deleteDevice(env.DB, dev.user_id, id);
      if (!ok) return err(404, "not_found");
      ctx.waitUntil(toBrain(env, dev, "/revoke", { method: "POST", body: JSON.stringify({ device_id: id }) }).catch(() => undefined));
      return json({ ok: true });
    }

    if (path === "/v1/memory" && (method === "GET" || method === "DELETE")) {
      return withCors(await toBrain(env, dev, "/memory", { method }));
    }
  }

  return err(404, "not_found");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const t0 = Date.now();
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      console.log(JSON.stringify({ route: new URL(req.url).pathname, error: e instanceof Error ? e.name : "error", ms: Date.now() - t0 }));
      return err(500, "internal_error");
    }
  },

  /** Nightly learner (02:00 IST): run /learn for every user. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const ids = await listUserIds(env.DB);
    const t0 = Date.now();
    const results = await Promise.allSettled(ids.map((id) => brainStub(env, id).learn(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    console.log(JSON.stringify({ evt: "cron.learn", users: ids.length, failed, ms: Date.now() - t0 }));
    void ctx;
  },
} satisfies ExportedHandler<Env>;
