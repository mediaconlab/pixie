/** 6-digit pairing codes: 10 minutes, single use, per-IP failed-claim rate limiting (D1). */
import { sha256Hex } from "./util";

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const MAX_FAILED_CLAIMS = 10;
export const FAIL_WINDOW_MS = 10 * 60 * 1000;
export const CODE_RE = /^\d{6}$/;

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function generateCode(rand: (buf: Uint32Array) => Uint32Array = (b) => crypto.getRandomValues(b)): string {
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    const x = rand(buf)[0]!;
    if (x < limit) return String(x % 1_000_000).padStart(6, "0");
  }
}

export function pairLink(baseUrl: string, code: string): string {
  return `pixie://pair?u=${encodeURIComponent(baseUrl)}&c=${code}`;
}

export async function startPairing(db: D1Database, userId: string, now: number): Promise<{ code: string; expires_at: number }> {
  // Housekeeping: drop expired/used codes and old failures.
  await db.batch([
    db.prepare("DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL").bind(now - 60_000),
    db.prepare("DELETE FROM pair_failures WHERE ts < ?").bind(now - FAIL_WINDOW_MS),
  ]);
  const expires_at = now + PAIR_TTL_MS;
  for (let i = 0; i < 8; i++) {
    const code = generateCode();
    const r = await db
      .prepare("INSERT OR IGNORE INTO pair_codes (code, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)")
      .bind(code, userId, now, expires_at)
      .run();
    if ((r.meta?.changes ?? 0) > 0) return { code, expires_at };
  }
  throw new Error("could not allocate pairing code");
}

async function ipKey(ip: string): Promise<string> {
  return (await sha256Hex(`pixie-ip:${ip}`)).slice(0, 32);
}

export async function isClaimRateLimited(db: D1Database, ip: string, now: number): Promise<boolean> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM pair_failures WHERE ip = ? AND ts > ?")
    .bind(await ipKey(ip), now - FAIL_WINDOW_MS)
    .first<{ n: number }>();
  return (r?.n ?? 0) >= MAX_FAILED_CLAIMS;
}

export async function recordFailedClaim(db: D1Database, ip: string, now: number): Promise<void> {
  await db.prepare("INSERT INTO pair_failures (ip, ts) VALUES (?, ?)").bind(await ipKey(ip), now).run();
}

/** Atomically consume a code. Returns the user id, or null if wrong/expired/used. */
export async function consumeCode(db: D1Database, code: string, now: number): Promise<string | null> {
  if (!CODE_RE.test(code)) return null;
  const r = await db
    .prepare("UPDATE pair_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .bind(now, code, now)
    .first<{ user_id: string }>();
  return r?.user_id ?? null;
}
