/** Per-user SQLite store (Durable Object `ctx.storage.sql`, or node:sqlite in tests). */

export type SqlValue = ArrayBuffer | string | number | null;

/** The subset of DO SqlStorage we use. */
export interface SqlLike {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

/**
 * Versioned schema migrations for the per-user Durable Object database.
 *
 * RULES
 * - Never edit or reorder a migration that has shipped. Existing users' databases already ran it.
 * - To change the schema, APPEND a new migration ({ version: N + 1, statements: [...] }).
 * - Versions are 1, 2, 3, ... with no gaps. The applied version lives in the single-row
 *   `schema_version` table; `migrate` runs every migration above it, in order, recording the
 *   version after each one.
 * - Migration 1 is the original schema, all `IF NOT EXISTS`, so databases created before
 *   versioning (tables present, no `schema_version`) run it harmlessly and land on version 1.
 *
 * Migrations are applied sequentially (synchronously, in the DO constructor) and the version is
 * recorded after each one, so a crash between migrations resumes at the next one on restart.
 * Write each migration so that re-running it after a partial failure is safe (IF NOT EXISTS etc.).
 */
export interface Migration {
  version: number;
  statements: readonly string[];
}

/** Migration 1: the original schema, exactly as it shipped before versioning. Never edit. */
const V1_SCHEMA: readonly string[] = [
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

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: [...V1_SCHEMA] },
  /** Migration 2: smart reply cards (PROTOCOL.md §5). Keys and counts only, never message text. */
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS reply_rules (
         id TEXT PRIMARY KEY,
         effect TEXT NOT NULL CHECK (effect IN ('always','never','only')),
         subject_type TEXT NOT NULL CHECK (subject_type IN ('contact','group','relation','all_groups','all_dms','all')),
         subject_key TEXT,
         subject_label TEXT NOT NULL,
         scope_key TEXT NOT NULL,
         conditions TEXT,
         expires_at INTEGER,
         source TEXT NOT NULL,
         utterance TEXT,
         created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_reply_rules_scope ON reply_rules(scope_key)`,
      /** one row per card outcome; subject_key is c:<contact key> (DM) or g:<group key> (group) */
      `CREATE TABLE IF NOT EXISTS reply_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         subject_key TEXT NOT NULL,
         relation_key TEXT NOT NULL,
         is_group INTEGER NOT NULL,
         outcome TEXT NOT NULL,
         active INTEGER NOT NULL DEFAULT 1,
         category TEXT,
         ts INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_reply_events_subject ON reply_events(subject_key, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_reply_events_ts ON reply_events(ts)`,
      /** decayed evidence per key (subject, r:<relation>, *:dm / *:group), as of updated_at */
      `CREATE TABLE IF NOT EXISTS reply_stats (
         key TEXT PRIMARY KEY,
         pos REAL NOT NULL DEFAULT 0,
         neg REAL NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL)`,
      /** reply cards Pixie showed for incoming messages, to learn from what happens to them */
      `CREATE TABLE IF NOT EXISTS reply_cards (
         proposal_id TEXT PRIMARY KEY,
         subject_key TEXT NOT NULL,
         relation_key TEXT NOT NULL,
         is_group INTEGER NOT NULL,
         contact_key TEXT NOT NULL,
         contact_name TEXT NOT NULL,
         group_key TEXT,
         group_name TEXT,
         category TEXT,
         exploration INTEGER NOT NULL DEFAULT 0,
         active INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'pending',
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_reply_cards_status ON reply_cards(status, expires_at)`,
      /** chat / group names seen in notifications, for resolving names in rules */
      `CREATE TABLE IF NOT EXISTS conversations (
         name_key TEXT NOT NULL,
         name TEXT NOT NULL,
         is_group INTEGER NOT NULL,
         messages INTEGER NOT NULL DEFAULT 0,
         last_ts INTEGER NOT NULL,
         PRIMARY KEY (name_key, is_group))`,
    ],
  },
  /**
   * Migration 3: copy legacy kv "blocked" whatsapp.reply patterns (from "never" on a draft card) into
   * reply_rules as DM "never" rules. Idempotent: deterministic ids + INSERT OR IGNORE. The kv entries
   * stay, because they also gate replies the user asks Pixie to send (decideTier); deleting the rule
   * via DELETE /v1/reply-rules/:id removes the matching kv entry too.
   */
  {
    version: 3,
    statements: [
      `INSERT OR IGNORE INTO reply_rules (id, effect, subject_type, subject_key, subject_label, scope_key, conditions, expires_at, source, utterance, created_at)
       SELECT
         'rr_mig_' || hex(substr(j.value, 16)),
         'never',
         CASE WHEN substr(j.value, 16) IN ('', '*') THEN 'all' ELSE 'contact' END,
         CASE WHEN substr(j.value, 16) IN ('', '*') THEN NULL ELSE substr(j.value, 16) END,
         CASE WHEN substr(j.value, 16) IN ('', '*') THEN 'everyone'
              ELSE COALESCE((SELECT c.name FROM contacts c WHERE c.name_key = substr(j.value, 16)), substr(j.value, 16)) END,
         CASE WHEN substr(j.value, 16) IN ('', '*') THEN 'all:' ELSE 'contact:' || substr(j.value, 16) || ':dm' END,
         NULL, NULL, 'migrated', NULL,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM kv, json_each(kv.value) AS j
       WHERE kv.key = 'blocked' AND json_valid(kv.value) AND j.value LIKE 'whatsapp.reply|%'`,
    ],
  },
  // Append new migrations here: { version: 4, statements: ["ALTER TABLE ..."] },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Current applied schema version (0 for a fresh or pre-versioning database). */
export function schemaVersion(sql: SqlLike): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  const rows = sql.exec<{ version: number }>("SELECT version FROM schema_version WHERE id = 1").toArray();
  return rows[0] ? Number(rows[0].version) : 0;
}

/** Apply every migration newer than the recorded version, in order. Returns the final version. */
export function migrate(sql: SqlLike, migrations: readonly Migration[] = MIGRATIONS): number {
  let current = schemaVersion(sql);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    for (const s of m.statements) sql.exec(s);
    sql.exec(
      "INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
      m.version,
    );
    current = m.version;
  }
  return current;
}

/** Back-compat name used by BrainCore. */
export function initSchema(sql: SqlLike): void {
  migrate(sql);
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
