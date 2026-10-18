import pg from 'pg';

/** Creates the test database if needed and applies migrations. Runs once before all tests. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/opsdb_test';
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  process.env.DATABASE_URL = url;
  const { migrate } = await import('../src/migrate');
  const { pool } = await import('../src/db');
  await migrate();
  await pool.end();
}
