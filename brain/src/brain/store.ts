/** Per-user SQLite store (Durable Object `ctx.storage.sql`, or node:sqlite in tests). */

export type SqlValue = ArrayBuffer | string | number | null;

/** The subset of DO SqlStorage we use. */
export interface SqlLike {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL CHECK (kind IN ('episode','fact','preference')),
     text TEXT NOT NULL,
     embedding TEXT,
     value REAL NOT NULL DEFAULT 0.5,
     hits INTEGER NOT NULL DEFAULT 0,
     ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)`,
  `CREATE TABLE IF NOT EXISTS preferences (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     text TEXT NOT NULL UNIQUE,
     source TEXT NOT NULL DEFAULT 'learned',
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS contacts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL UNIQUE,
     phone_hash TEXT,
     relation TEXT,
     importance REAL NOT NULL DEFAULT 0.4,
     interactions INTEGER NOT NULL DEFAULT 0,
     last_ts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_hash)`,
  /** interaction log: one row per call/message (no content), for repeats + importance learning */
  `CREATE TABLE IF NOT EXISTS interactions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     who_key TEXT NOT NULL,
     type TEXT NOT NULL,
     ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_who_ts ON interactions(who_key, ts)`,
  /** latest replyable thread / call number per sender (24 h), so chat commands can target them */
  `CREATE TABLE IF NOT EXISTS threads (
     who_key TEXT PRIMARY KEY,
     who TEXT NOT NULL,
     msg_key TEXT,
     number TEXT,
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS decisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     proposal_id TEXT,
     kind TEXT NOT NULL,
     pattern TEXT NOT NULL,
     verdict TEXT NOT NULL,
     draft TEXT,
     final TEXT,
     ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_pattern ON decisions(pattern, ts)`,
  `CREATE TABLE IF NOT EXISTS proposals (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT NOT NULL,
     payload TEXT NOT NULL,
     executor TEXT NOT NULL,
     pattern TEXT NOT NULL,
     target_device TEXT,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS context (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS digest (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sender TEXT NOT NULL,
     app TEXT NOT NULL,
     summary TEXT NOT NULL,
     urgency REAL NOT NULL,
     ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reminders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     text TEXT NOT NULL,
     at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS model_calls (ts INTEGER NOT NULL)`,
];

export function initSchema(sql: SqlLike): void {
  for (const s of SCHEMA) sql.exec(s);
}

export class KV {
  constructor(private readonly sql: SqlLike) {}

  get<T>(key: string, dflt: T): T {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray();
    if (!rows.length) return dflt;
    try {
      return JSON.parse(rows[0]!.value) as T;
    } catch {
      return dflt;
    }
  }

  set(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }
}

export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
}
