/** Device tokens: 32 random bytes, base64url (43 chars). Only the SHA-256 hash is stored. */
import { deviceByTokenHash, touchDevice, type DeviceWithUser } from "./db";
import { base64url, randomBytes, sha256Hex } from "./util";

export function generateToken(): string {
  return base64url(randomBytes(32));
}

export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Extract a bearer token from the Authorization header, or `?token=` (WebSocket fallback). */
export function extractToken(req: Request, allowQuery: boolean): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  let t = m ? m[1]! : null;
  if (!t && allowQuery) t = new URL(req.url).searchParams.get("token");
  return t && TOKEN_RE.test(t) ? t : null;
}

/** last_seen is only written if older than this, to keep D1 writes low. */
const TOUCH_INTERVAL_MS = 60_000;

export async function authenticate(req: Request, db: D1Database, opts: { allowQuery?: boolean; now?: number; waitUntil?: (p: Promise<unknown>) => void } = {}): Promise<DeviceWithUser | null> {
  const token = extractToken(req, !!opts.allowQuery);
  if (!token) return null;
  const dev = await deviceByTokenHash(db, await hashToken(token));
  if (!dev) return null;
  const now = opts.now ?? Date.now();
  if (now - dev.last_seen > TOUCH_INTERVAL_MS) {
    const p = touchDevice(db, dev.id, now).catch(() => {});
    if (opts.waitUntil) opts.waitUntil(p);
    else await p;
    dev.last_seen = now;
  }
  return dev;
}
