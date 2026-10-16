import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth";
import type { Env } from "../src/env";
import { handle } from "../src/index";
import { fakeD1 } from "./d1";

const BASE = "https://pixie.test";
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeEnv(allowSignup = "0") {
  const DB = fakeD1();
  const doCalls: Array<{ user: string; path: string; method: string; headers: Record<string, string> }> = [];
  const USER_BRAIN = {
    idFromName: (n: string) => ({ name: n }),
    get: (id: { name: string }) => ({
      fetch: async (url: string | Request, init?: RequestInit) => {
        const req = typeof url === "string" ? new Request(url, init) : url;
        doCalls.push({ user: id.name, path: new URL(req.url).pathname, method: req.method, headers: Object.fromEntries(req.headers) });
        const p = new URL(req.url).pathname;
        if (p === "/online") return Response.json({ online: [] });
        if (p === "/memory") return Response.json(req.method === "GET" ? { facts: [], memories: [], preferences: [] } : { ok: true });
        return Response.json({ ok: true });
      },
    }),
  };
  const env = { DB, USER_BRAIN, AI: {}, ALLOW_SIGNUP: allowSignup } as unknown as Env;
  return { env, DB, doCalls };
}

let E: ReturnType<typeof makeEnv>;
const call = (path: string, init: RequestInit & { json?: unknown; token?: string; ip?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  headers.set("CF-Connecting-IP", init.ip ?? "1.2.3.4");
  return handle(new Request(BASE + path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined }), E.env, ctx);
};
const register = () => call("/v1/register", { json: { name: "Ishaan", device: { kind: "mac", name: "MacBook Air" } } });

beforeEach(() => {
  E = makeEnv();
});

describe("REST", () => {
  it("health", async () => {
    const r = await call("/health");
    expect(await r.json()).toEqual({ ok: true, version: "1.0.0", protocol: 1, min_protocol: 1 });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("CORS preflight", async () => {
    const r = await call("/v1/devices", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("first registration claims the instance; second is closed", async () => {
    const r = await register();
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.user_id).toMatch(/^usr_/);
    expect(b.device_id).toMatch(/^dev_/);
    expect(b.token).toHaveLength(43);
    // only the hash is stored
    const row = E.DB.raw.prepare("SELECT token_hash FROM devices").get() as any;
    expect(row.token_hash).toBe(await hashToken(b.token));
    expect(JSON.stringify(E.DB.raw.prepare("SELECT * FROM devices").all())).not.toContain(b.token);

    const r2 = await register();
    expect(r2.status).toBe(403);
    expect(await r2.json()).toEqual({ error: "registration_closed" });
  });

  it("ALLOW_SIGNUP=1 permits more users", async () => {
    E = makeEnv("1");
    await register();
    const r2 = await register();
    expect(r2.status).toBe(200);
    expect(E.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE is_owner = 1").get()).toMatchObject({ n: 1 });
  });

  it("only mac may register", async () => {
    const r = await call("/v1/register", { json: { name: "x", device: { kind: "android", name: "Pixel" } } });
    expect(r.status).toBe(400);
  });

  it("auth required", async () => {
    expect((await call("/v1/devices")).status).toBe(401);
    expect((await call("/v1/devices", { token: "x".repeat(43) })).status).toBe(401);
    expect(await (await call("/v1/devices")).json()).toEqual({ error: "unauthorized" });
  });

  it("pair start → claim → device list; code is single-use", async () => {
    const owner = (await (await register()).json()) as any;
    const s = await call("/v1/pair/start", { json: {}, token: owner.token });
    const sb = (await s.json()) as any;
    expect(sb.code).toMatch(/^\d{6}$/);
    expect(sb.expires_at).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(sb.link).toBe(`pixie://pair?u=${encodeURIComponent(BASE)}&c=${sb.code}`);

    const c = await call("/v1/pair/claim", { json: { code: sb.code, device: { kind: "android", name: "Pixel 8" } } });
    expect(c.status).toBe(200);
    const cb = (await c.json()) as any;
    expect(cb.user_id).toBe(owner.user_id);
    expect(cb.token).toHaveLength(43);

    const again = await call("/v1/pair/claim", { json: { code: sb.code, device: { kind: "ide", name: "VS Code" } } });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "bad_code" });

    const list = (await (await call("/v1/devices", { token: cb.token })).json()) as any;
    expect(list.devices.map((d: any) => d.kind).sort()).toEqual(["android", "mac"]);
    expect(list.devices[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), last_seen: expect.any(Number), online: false }));
  });

  it("expired code is rejected", async () => {
    const owner = (await (await register()).json()) as any;
    const sb = (await (await call("/v1/pair/start", { json: {}, token: owner.token })).json()) as any;
    E.DB.raw.prepare("UPDATE pair_codes SET expires_at = 1").run();
    const c = await call("/v1/pair/claim", { json: { code: sb.code, device: { kind: "android", name: "P" } } });
    expect(c.status).toBe(404);
  });

  it("rate-limits failed claims: 10 per IP per 10 min", async () => {
    await register();
    for (let i = 0; i < 10; i++) {
      expect((await call("/v1/pair/claim", { json: { code: "000000", device: { kind: "android", name: "P" } } })).status).toBe(404);
    }
    const r = await call("/v1/pair/claim", { json: { code: "000000", device: { kind: "android", name: "P" } } });
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error).toBe("rate_limited");
    // a different IP is unaffected
    expect((await call("/v1/pair/claim", { ip: "5.6.7.8", json: { code: "000000", device: { kind: "android", name: "P" } } })).status).toBe(404);
  });

  it("claim cannot register a mac", async () => {
    const r = await call("/v1/pair/claim", { json: { code: "123456", device: { kind: "mac", name: "M" } } });
    expect(r.status).toBe(400);
  });

  it("DELETE device revokes its token and notifies the DO", async () => {
    const owner = (await (await register()).json()) as any;
    const sb = (await (await call("/v1/pair/start", { json: {}, token: owner.token })).json()) as any;
    const phone = (await (await call("/v1/pair/claim", { json: { code: sb.code, device: { kind: "android", name: "P" } } })).json()) as any;
    const d = await call(`/v1/devices/${phone.device_id}`, { method: "DELETE", token: owner.token });
    expect(await d.json()).toEqual({ ok: true });
    expect((await call("/v1/devices", { token: phone.token })).status).toBe(401);
    expect(E.doCalls.some((c) => c.path === "/revoke")).toBe(true);
    expect((await call(`/v1/devices/${phone.device_id}`, { method: "DELETE", token: owner.token })).status).toBe(404);
  });

  it("memory routes go to the user's DO", async () => {
    const owner = (await (await register()).json()) as any;
    expect(await (await call("/v1/memory", { token: owner.token })).json()).toEqual({ facts: [], memories: [], preferences: [] });
    expect(await (await call("/v1/memory", { method: "DELETE", token: owner.token })).json()).toEqual({ ok: true });
    expect(E.doCalls.filter((c) => c.path === "/memory").every((c) => c.user === owner.user_id)).toBe(true);
  });

  it("reply-rules routes require auth and go to the user's DO", async () => {
    const owner = (await (await register()).json()) as any;
    expect((await call("/v1/reply-rules")).status).toBe(401);
    expect((await call("/v1/reply-rules/rr_1", { method: "DELETE" })).status).toBe(401);
    expect((await call("/v1/reply-rules/reset-learning", { method: "POST" })).status).toBe(401);
    E.doCalls.length = 0;
    expect((await call("/v1/reply-rules", { token: owner.token })).status).toBe(200);
    expect((await call("/v1/reply-rules/rr_1", { method: "DELETE", token: owner.token })).status).toBe(200);
    const r = await call("/v1/reply-rules/reset-learning", { method: "POST", token: owner.token });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(E.doCalls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /reply-rules", "DELETE /reply-rules/rr_1", "POST /reply-rules/reset-learning"]);
    expect(E.doCalls.every((c) => c.user === owner.user_id)).toBe(true);
    expect((await call("/v1/reply-rules/bad id!", { method: "DELETE", token: owner.token })).status).toBe(404);
  });

  it("ws: requires upgrade header; forwards identity headers; accepts ?token=", async () => {
    const owner = (await (await register()).json()) as any;
    expect((await call("/v1/ws", { token: owner.token })).status).toBe(426);
    await call(`/v1/ws?token=${owner.token}`, { headers: { Upgrade: "websocket" } });
    const ws = E.doCalls.find((c) => c.path === "/ws")!;
    expect(ws.user).toBe(owner.user_id);
    expect(ws.headers["x-device-id"]).toBe(owner.device_id);
    expect(ws.headers["x-device-kind"]).toBe("mac");
    expect(ws.headers["x-user-id"]).toBe(owner.user_id);
  });

  it("unknown routes → 404 json", async () => {
    const r = await call("/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });
});
