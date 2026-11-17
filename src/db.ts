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
