import pg from 'pg';
import { config } from './config';

// DATE columns come back as 'YYYY-MM-DD' strings instead of JS Dates (no timezone surprises).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export type Tx = pg.PoolClient;

/** Run fn inside a transaction. Commit on success, rollback on any throw. */
export async function tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
