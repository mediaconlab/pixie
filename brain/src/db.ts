/** D1 access for the global registry: users, devices, pair codes. */
import type { DeviceKind } from "./protocol";

export interface UserRow {
  id: string;
  name: string;
  is_owner: number;
  created_at: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  kind: DeviceKind;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen: number;
}

export interface DeviceWithUser extends DeviceRow {
  user_name: string;
}

export async function getOwnerId(db: D1Database): Promise<string | null> {
  const r = await db.prepare("SELECT id FROM users WHERE is_owner = 1 LIMIT 1").first<{ id: string }>();
  return r?.id ?? null;
}

/**
 * Create the owner user. Returns false if an owner already exists (the partial unique index
 * idx_users_single_owner makes concurrent first registrations safe).
 */
export async function createOwner(db: D1Database, u: Omit<UserRow, "is_owner">): Promise<boolean> {
  const r = await db
    .prepare("INSERT OR IGNORE INTO users (id, name, is_owner, created_at) VALUES (?, ?, 1, ?)")
    .bind(u.id, u.name, u.created_at)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function createUser(db: D1Database, u: UserRow): Promise<void> {
  await db.prepare("INSERT INTO users (id, name, is_owner, created_at) VALUES (?, ?, ?, ?)").bind(u.id, u.name, u.is_owner, u.created_at).run();
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function listUserIds(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT id FROM users").all<{ id: string }>();
  return (r.results ?? []).map((x) => x.id);
}

export async function createDevice(db: D1Database, d: DeviceRow): Promise<void> {
  await db
    .prepare("INSERT INTO devices (id, user_id, kind, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(d.id, d.user_id, d.kind, d.name, d.token_hash, d.created_at, d.last_seen)
    .run();
}

export async function deviceByTokenHash(db: D1Database, hash: string): Promise<DeviceWithUser | null> {
  return db
    .prepare("SELECT d.*, u.name AS user_name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?")
    .bind(hash)
    .first<DeviceWithUser>();
}

export async function touchDevice(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, id).run();
}

export async function listDevices(db: D1Database, userId: string): Promise<DeviceRow[]> {
  const r = await db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").bind(userId).all<DeviceRow>();
  return r.results ?? [];
}

export async function deleteDevice(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}
