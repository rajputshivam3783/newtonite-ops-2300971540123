import { beforeEach, describe, expect, it } from 'vitest';
import { api, as, makeTeam, makeUser, newItem, resetDb, rows, type TestUser } from './helpers';
import { pool } from '../src/db';
import { processNextJob } from '../src/worker';

let team: string;
let creator: TestUser, claimer: TestUser, lead: TestUser;
beforeEach(async () => {
  await resetDb();
  team = await makeTeam('Platform');
  creator = await makeUser('Creator', { [team]: 'member' });
  claimer = await makeUser('Claimer', { [team]: 'member' });
  lead = await makeUser('Lead', { [team]: 'lead' });
});

describe('transactional outbox + worker', () => {
  it('writes the job with the change, and the worker turns it into one notification', async () => {
    const item = await newItem(creator, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(claimer)).expect(200);

    const [job] = await rows('SELECT * FROM jobs');
    expect(job).toMatchObject({ type: 'item_claimed', status: 'pending', attempts: 0 });

    expect(await processNextJob()).toBe('done');
    expect(await processNextJob()).toBe('none');
    const n = await rows('SELECT user_id, message FROM notifications');
    expect(n).toHaveLength(1);
    expect(n[0].user_id).toBe(creator.id);
    expect(n[0].message).toContain('Claimer claimed');

    const mine = await api().get('/api/notifications').set(as(creator));
    expect(mine.body.notifications).toHaveLength(1);
  });

  it('processing the same job twice still produces one notification (idempotent handler)', async () => {
    const item = await newItem(creator, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(claimer));
    await processNextJob();
    // simulate "worker crashed after the side effect but before the job was marked done"
    await pool.query(`UPDATE jobs SET status = 'pending'`);
    expect(await processNextJob()).toBe('done');
    expect(await rows('SELECT 1 FROM notifications')).toHaveLength(1);
  });

  it('self-claims do not notify yourself', async () => {
    const item = await newItem(creator, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(creator));
    await processNextJob();
    expect(await rows('SELECT 1 FROM notifications')).toHaveLength(0);
  });

  it('requesting approval notifies the leads (not the requester)', async () => {
    const item = await newItem(creator, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(claimer));
    await api().post(`/api/items/${item.id}/transition`).set(as(claimer)).send({ to: 'in_progress' });
    await api().post(`/api/items/${item.id}/transition`).set(as(claimer)).send({ to: 'awaiting_approval' });
    while ((await processNextJob()) !== 'none') { /* drain */ }
    const n = await rows(`SELECT user_id FROM notifications WHERE message LIKE 'Approval requested%'`);
    expect(n.map((r) => r.user_id)).toEqual([lead.id]);
  });

  it('a failing job is retried with backoff, then marked failed at max attempts; partial writes are rolled back', async () => {
    const item = await newItem(creator, team);
    await pool.query(`INSERT INTO jobs (type, payload, max_attempts) VALUES ('flaky', $1, 3)`, [JSON.stringify({ item_id: item.id })]);
    const flaky = async (c: any, job: any) => {
      // side effect first, then blow up: this write must not survive
      await c.query(`INSERT INTO notifications (user_id, item_id, message, dedupe_key) VALUES ($1,$2,'partial',$3)`,
        [creator.id, job.payload.item_id, `flaky:${job.attempts}`]);
      throw new Error('smtp down');
    };

    expect(await processNextJob({ flaky })).toBe('retry');
    let [job] = await rows('SELECT * FROM jobs');
    expect(job).toMatchObject({ status: 'pending', attempts: 1, last_error: 'smtp down' });
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now()); // backoff: not due yet
    expect(await processNextJob({ flaky })).toBe('none');               // so the worker leaves it alone

    await pool.query('UPDATE jobs SET run_at = now()');
    expect(await processNextJob({ flaky })).toBe('retry');
    await pool.query('UPDATE jobs SET run_at = now()');
    expect(await processNextJob({ flaky })).toBe('failed');

    [job] = await rows('SELECT * FROM jobs');
    expect(job).toMatchObject({ status: 'failed', attempts: 3, last_error: 'smtp down' });
    expect(await rows('SELECT 1 FROM notifications')).toHaveLength(0);
    await pool.query('UPDATE jobs SET run_at = now()');
    expect(await processNextJob({ flaky })).toBe('none'); // failed jobs are never picked again
  });

  it('two workers running at once never process the same job twice', async () => {
    const item = await newItem(creator, team);
    for (let i = 0; i < 6; i++) {
      await pool.query(`INSERT INTO jobs (type, payload) VALUES ('item_claimed', $1)`, [JSON.stringify({ item_id: item.id, actor_id: claimer.id })]);
    }
    const drain = async () => { let n = 0; while ((await processNextJob()) === 'done') n++; return n; };
    const counts = await Promise.all([drain(), drain(), drain()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
    expect(await rows(`SELECT 1 FROM jobs WHERE status = 'done'`)).toHaveLength(6);
    expect(await rows('SELECT 1 FROM notifications')).toHaveLength(6); // one per job, no duplicates
  });
});
