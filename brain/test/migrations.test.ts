import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration, migrate, schemaVersion } from "../src/brain/store";
import { memorySql } from "./helpers";

const tables = (sql: ReturnType<typeof memorySql>) =>
  sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray().map((r) => r.name);
const columns = (sql: ReturnType<typeof memorySql>, t: string) =>
  sql.exec<{ name: string }>(`PRAGMA table_info(${t})`).toArray().map((r) => r.name);

describe("DO schema migrations", () => {
  it("versions are 1..N with no gaps", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it("a fresh database ends at the latest version with every table", () => {
    const sql = memorySql();
    expect(migrate(sql)).toBe(LATEST_SCHEMA_VERSION);
    expect(schemaVersion(sql)).toBe(LATEST_SCHEMA_VERSION);
    expect(tables(sql)).toEqual(expect.arrayContaining(["kv", "memories", "preferences", "contacts", "interactions", "threads", "decisions", "proposals", "context", "digest", "reminders", "model_calls", "schema_version", "reply_rules", "reply_events", "reply_stats", "reply_cards", "conversations", "activity_log", "pet_log", "thoughts"]));
  });

  it("a pre-versioning database (old SCHEMA, no version table) upgrades cleanly and keeps its data", () => {
    const sql = memorySql();
    // What every existing user has today: the original statements, applied with no version tracking.
    for (const s of MIGRATIONS[0]!.statements) sql.exec(s);
    sql.exec("INSERT INTO kv (key, value) VALUES ('user_id', '\"usr_1\"')");
    sql.exec("INSERT INTO memories (kind, text, ts) VALUES ('fact', 'likes tea', 1)");
    expect(tables(sql)).not.toContain("schema_version");

    expect(migrate(sql)).toBe(LATEST_SCHEMA_VERSION);
    expect(schemaVersion(sql)).toBe(LATEST_SCHEMA_VERSION);
    expect(sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'user_id'").toArray()[0]!.value).toBe('"usr_1"');
    expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memories").toArray()[0]!.n).toBe(1);
  });

  it("running migrations twice is a no-op", () => {
    const sql = memorySql();
    migrate(sql);
    const before = tables(sql);
    expect(migrate(sql)).toBe(LATEST_SCHEMA_VERSION);
    expect(tables(sql)).toEqual(before);
    expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version").toArray()[0]!.n).toBe(1);
  });

  it("an appended migration that adds a column applies exactly once", () => {
    const withV2: Migration[] = [
      ...MIGRATIONS,
      { version: LATEST_SCHEMA_VERSION + 1, statements: ["ALTER TABLE reminders ADD COLUMN repeat TEXT"] },
    ];
    const sql = memorySql();
    migrate(sql); // a database already on the current version
    sql.exec("INSERT INTO reminders (text, at) VALUES ('stretch', 5)");

    expect(migrate(sql, withV2)).toBe(LATEST_SCHEMA_VERSION + 1);
    expect(columns(sql, "reminders")).toContain("repeat");
    // A second run would throw "duplicate column" if the ALTER ran again.
    expect(() => migrate(sql, withV2)).not.toThrow();
    expect(schemaVersion(sql)).toBe(LATEST_SCHEMA_VERSION + 1);
    expect(sql.exec<{ text: string; repeat: string | null }>("SELECT text, repeat FROM reminders").toArray()).toEqual([{ text: "stretch", repeat: null }]);

    // A fresh database gets both migrations in order.
    const fresh = memorySql();
    expect(migrate(fresh, withV2)).toBe(LATEST_SCHEMA_VERSION + 1);
    expect(columns(fresh, "reminders")).toContain("repeat");
  });
});
