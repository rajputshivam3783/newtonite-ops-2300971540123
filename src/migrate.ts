import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(): Promise<string[]> {
  const applied: string[] = [];
  const c = await pool.connect();
  try {
    // advisory lock so api + worker containers starting together don't race
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
    await c.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    c.release();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then((a) => { console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database up to date'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
