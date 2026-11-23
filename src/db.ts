import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config.ts";

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting), and numbers as numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // Give up on reaching the database after 10 seconds (the phone retries) instead of waiting forever.
  connectionTimeoutMillis: 10_000,
  // jit=off: PostgreSQL's JIT compiler spent ~0.65 s compiling the reminders query for a few milliseconds of work
  // (phase 3 performance check); this app's queries are all small. idle_in_transaction_session_timeout: a
  // transaction left open by a stuck request is rolled back after a minute instead of holding its locks.
  options: "-c jit=off -c idle_in_transaction_session_timeout=60000",
});

// An idle connection dropping (database restarted, network blip) emits "error" on the pool; without a listener
// that crashes the whole app. The pool already discards the broken connection and opens a new one when needed.
pool.on("error", (err) => {
  console.error(JSON.stringify({ level: 50, time: Date.now(), msg: `idle database connection lost: ${err.message}` }));
});

export type Db = Pick<PoolClient, "query">;

export async function q<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query<T>(sql, params);
  return r.rows;
}

export async function one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  // The connection can also drop between two queries of a transaction; note it instead of crashing,
  // and don't hand a broken connection back to the pool.
  let broken = false;
  const onError = () => { broken = true; };
  c.on("error", onError);
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => { broken = true; });
    throw e;
  } finally {
    c.off("error", onError);
    c.release(broken || undefined);
  }
}
