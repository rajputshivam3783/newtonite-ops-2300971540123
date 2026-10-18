import { beforeEach, describe, expect, it } from 'vitest';
import { api, as, makeTeam, makeUser, newItem, resetDb, rows } from './helpers';
import { pool, tx } from '../src/db';
import { claimItem } from '../src/items';
import { loadUser } from '../src/auth';

let team: string;
beforeEach(async () => { await resetDb(); team = await makeTeam('Payments'); });

describe('concurrent claim', () => {
  it('lets exactly one of 8 parallel claimers win; the rest get 409', async () => {
    const creator = await makeUser('Creator', { [team]: 'member' });
    const claimers = await Promise.all(Array.from({ length: 8 }, (_, i) => makeUser(`Claimer ${i}`, { [team]: 'member' })));
    const item = await newItem(creator, team);

    const results = await Promise.all(
      claimers.map((u) => api().post(`/api/items/${item.id}/claim`).set(as(u))),
    );

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(losers.every((r) => r.body.error.code === 'already_claimed')).toBe(true);
    expect(losers[0].body.error.latest.assignee_id).toBe(winners[0].body.assignee_id);

    const [row] = await rows('SELECT assignee_id, version FROM work_items WHERE id = $1', [item.id]);
    expect(row.assignee_id).toBe(winners[0].body.assignee_id);
    expect(row.version).toBe(2); // created at v1, bumped once by the single winner
    expect(await rows(`SELECT 1 FROM activity_events WHERE item_id = $1 AND type = 'claimed'`, [item.id])).toHaveLength(1);
    expect(await rows(`SELECT 1 FROM jobs WHERE type = 'item_claimed'`)).toHaveLength(1);
  });
});

describe('stale edits (optimistic locking)', () => {
  it('rejects an update made with an old version and leaves the data unchanged', async () => {
    const u = await makeUser('Editor', { [team]: 'member' });
    const item = await newItem(u, team, { title: 'Original' });

    const first = await api().patch(`/api/items/${item.id}`).set(as(u)).send({ version: 1, title: 'Edit A' });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    const stale = await api().patch(`/api/items/${item.id}`).set(as(u)).send({ version: 1, title: 'Edit B' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_version');
    expect(stale.body.error.latest.title).toBe('Edit A'); // client gets the latest to reconcile

    const [row] = await rows('SELECT title, version FROM work_items WHERE id = $1', [item.id]);
    expect(row).toMatchObject({ title: 'Edit A', version: 2 });
  });

  it('two simultaneous edits from the same version: one wins, one gets 409', async () => {
    const u = await makeUser('Editor', { [team]: 'member' });
    const item = await newItem(u, team);
    const [a, b] = await Promise.all([
      api().patch(`/api/items/${item.id}`).set(as(u)).send({ version: 1, title: 'Race A' }),
      api().patch(`/api/items/${item.id}`).set(as(u)).send({ version: 1, title: 'Race B' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const [row] = await rows('SELECT version FROM work_items WHERE id = $1', [item.id]);
    expect(row.version).toBe(2);
  });
});

describe('history is atomic with the change', () => {
  it('a rolled-back transaction leaves no item change, no event, no job', async () => {
    const creator = await makeUser('Creator', { [team]: 'member' });
    const other = await makeUser('Other', { [team]: 'member' });
    const item = await newItem(creator, team);
    const user = (await loadUser(other.id))!;

    await expect(
      tx(async (c) => { await claimItem(c, user, item.id); throw new Error('boom after claim'); }),
    ).rejects.toThrow('boom');

    const [row] = await rows('SELECT assignee_id, version FROM work_items WHERE id = $1', [item.id]);
    expect(row).toMatchObject({ assignee_id: null, version: 1 });
    expect(await rows(`SELECT 1 FROM activity_events WHERE type = 'claimed'`)).toHaveLength(0);
    expect(await rows(`SELECT 1 FROM jobs`)).toHaveLength(0);
  });

  it('activity_events is append-only at the database level', async () => {
    const u = await makeUser('U', { [team]: 'member' });
    await newItem(u, team);
    await expect(pool.query(`UPDATE activity_events SET type = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM activity_events`)).rejects.toThrow(/append-only/);
  });
});
