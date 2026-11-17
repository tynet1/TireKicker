import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { pool } from "./db.ts";

const LOCK_ID = 727001;

/** Apply db/migrations/NNN_*.sql in order, each in its own transaction. Safe to run concurrently. */
export async function migrate(log: (msg: string) => void = console.log): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(config.migrationsDir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(config.migrationsDir, f), "utf8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
      log(`migration applied: ${f}`);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    c.release();
  }
  return applied;
}
