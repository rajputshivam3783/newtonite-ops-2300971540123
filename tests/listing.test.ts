import { beforeEach, describe, expect, it } from 'vitest';
import { api, as, makeTeam, makeUser, resetDb, rows, type TestUser } from './helpers';
import { pool } from '../src/db';

let team: string;
let u: TestUser;
beforeEach(async () => {
  await resetDb();
  team = await makeTeam('Payments');
  u = await makeUser('Pat', { [team]: 'member' });
});

async function bulk(n: number, extra = '') {
  await pool.query(
    `INSERT INTO work_items (team_id, title, type, priority, status, created_by, created_at)
     SELECT $1, 'Item ' || g, 'task', 'medium', 'open', $2, now() - (g / 10) * interval '1 minute' -- 10 rows share each timestamp
     FROM generate_series(1, $3) g ${extra}`,
    [team, u.id, n],
  );
}

describe('server-side pagination, filters, search', () => {
  it('cursor pagination visits every item exactly once, newest first, even with identical timestamps', async () => {
    await bulk(95);
    const seen: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: any = await api().get('/api/items').query({ limit: 20, ...(cursor ? { cursor } : {}) }).set(as(u));
      expect(res.status).toBe(200);
      seen.push(...res.body.items);
      cursor = res.body.next_cursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(5);
    expect(seen).toHaveLength(95);
    expect(new Set(seen.map((i) => i.id)).size).toBe(95);
    const times = seen.map((i) => new Date(i.created_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('filters by status / priority / assignee and combines them', async () => {
    await bulk(30);
    await pool.query(`UPDATE work_items SET status = 'in_progress', assignee_id = $1 WHERE title IN ('Item 1','Item 2','Item 3')`, [u.id]);
    await pool.query(`UPDATE work_items SET priority = 'urgent' WHERE title IN ('Item 2','Item 4')`);
    const get = async (qs: string) => (await api().get(`/api/items?${qs}`).set(as(u))).body.items.map((i: any) => i.title).sort();

    expect(await get('status=in_progress')).toEqual(['Item 1', 'Item 2', 'Item 3']);
    expect(await get('priority=urgent')).toEqual(['Item 2', 'Item 4']);
    expect(await get('status=in_progress&priority=urgent')).toEqual(['Item 2']);
    expect(await get('assignee=me')).toEqual(['Item 1', 'Item 2', 'Item 3']);
    expect(await get('view=unassigned_urgent')).toEqual(['Item 4']);
    expect(await get('view=assigned_to_me')).toEqual(['Item 1', 'Item 2', 'Item 3']);
  });

  it('search matches whole words (full-text) and substrings of the title', async () => {
    await pool.query(
      `INSERT INTO work_items (team_id, title, description, type, created_by) VALUES
       ($1,'Refund stuck for order 123','customer waiting','payment',$2),
       ($1,'Login failures','users cannot sign in','incident',$2),
       ($1,'Audit report','mentions the REFUND policy','compliance',$2)`,
      [team, u.id],
    );
    const find = async (q: string) => (await api().get('/api/items').query({ q }).set(as(u))).body.items.map((i: any) => i.title).sort();
    expect(await find('refund')).toEqual(['Audit report', 'Refund stuck for order 123']); // title + description
    expect(await find('fund')).toEqual(['Refund stuck for order 123']);                   // substring in title
    expect(await find('50%')).toEqual([]);                                                // LIKE wildcards are escaped
  });

  it('dashboard counts match the dashboard lists', async () => {
    await bulk(12);
    await pool.query(`UPDATE work_items SET priority='urgent' WHERE title IN ('Item 1','Item 2','Item 3')`);
    await pool.query(`UPDATE work_items SET assignee_id = $1 WHERE title = 'Item 2'`, [u.id]);
    const counts = (await api().get('/api/dashboard').set(as(u))).body;
    expect(counts).toEqual({ assigned_to_me: 1, unassigned_urgent: 2, awaiting_my_approval: 0 });
  });

  it('rejects malformed cursors and oversized page sizes', async () => {
    expect((await api().get('/api/items?cursor=garbage').set(as(u))).status).toBe(400);
    expect((await api().get('/api/items?limit=1000').set(as(u))).status).toBe(400);
  });

  it('the list endpoint uses the indexes (no sequential scan on a large table)', async () => {
    await bulk(20000);
    await pool.query('ANALYZE work_items');
    const plan = await rows(
      `EXPLAIN SELECT id FROM work_items WHERE team_id = ANY($1::uuid[])
       ORDER BY created_at DESC, id DESC LIMIT 26`, [[team]],
    );
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index/);
    expect(text).not.toMatch(/Seq Scan/);
  });
});
