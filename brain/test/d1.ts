import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Minimal D1Database over node:sqlite, enough for src/db.ts and src/pairing.ts. */
export function fakeD1(): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    async first<T>() {
      const rows = raw.prepare(sql).all(...(binds as never[]));
      return (rows[0] ? { ...rows[0] } : null) as T | null;
    },
    async all<T>() {
      return { results: raw.prepare(sql).all(...(binds as never[])).map((r) => ({ ...r })) as T[], success: true, meta: {} };
    },
    async run() {
      const r = raw.prepare(sql).run(...(binds as never[]));
      return { success: true, meta: { changes: Number(r.changes) }, results: [] };
    },
  });
  return {
    raw,
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database & { raw: DatabaseSync };
}
