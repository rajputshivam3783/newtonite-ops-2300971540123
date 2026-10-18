import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db';
import { handlers as defaultHandlers, type Handler } from './jobs';

export type Outcome = 'none' | 'done' | 'retry' | 'failed';

/** 2s, 4s, 8s, ... capped at 5 minutes */
const backoffSeconds = (attempts: number) => Math.min(2 ** attempts, 300);

/**
 * Process at most one due job.
 *  - FOR UPDATE SKIP LOCKED: several workers can run without picking the same job.
 *  - The handler runs inside the same transaction as the "done" mark, so a crash mid-job
 *    rolls everything back and the job is simply picked up again (at-least-once delivery).
 *  - A SAVEPOINT lets us undo a failed handler's partial writes but still record the failure.
 */
export async function processNextJob(handlers: Record<string, Handler> = defaultHandlers): Promise<Outcome> {
  return tx(async (c) => {
    const r = await c.query(
      `SELECT * FROM jobs WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const job = r.rows[0];
    if (!job) return 'none';

    await c.query('SAVEPOINT job_run');
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`No handler for job type "${job.type}"`);
      await handler(c, job);
      await c.query('RELEASE SAVEPOINT job_run');
      await c.query(`UPDATE jobs SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE id = $1`, [job.id]);
      return 'done';
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT job_run');
      const attempts = job.attempts + 1;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempts >= job.max_attempts) {
        await c.query(`UPDATE jobs SET status = 'failed', attempts = $2, last_error = $3, updated_at = now() WHERE id = $1`, [job.id, attempts, msg]);
        return 'failed';
      }
      await c.query(
        `UPDATE jobs SET attempts = $2, last_error = $3, run_at = now() + make_interval(secs => $4), updated_at = now() WHERE id = $1`,
        [job.id, attempts, msg, backoffSeconds(attempts)],
      );
      return 'retry';
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let stop = false;
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
  console.log('worker started');
  while (!stop) {
    try {
      if ((await processNextJob()) === 'none') await sleep(1000);
    } catch (e) {
      console.error('worker loop error', e);
      await sleep(2000);
    }
  }
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
