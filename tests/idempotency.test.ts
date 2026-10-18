import { beforeEach, describe, expect, it } from 'vitest';
import { api, as, makeTeam, makeUser, newItem, resetDb, rows } from './helpers';

let team: string;
beforeEach(async () => { await resetDb(); team = await makeTeam('Support'); });

const body = (team_id: string) => ({ team_id, title: 'Double click me', type: 'task' });

describe('Idempotency-Key', () => {
  it('same key sent twice creates one item and returns the same response', async () => {
    const u = await makeUser('Dana', { [team]: 'member' });
    const a = await api().post('/api/items').set(as(u)).set('Idempotency-Key', 'k-1').send(body(team));
    const b = await api().post('/api/items').set(as(u)).set('Idempotency-Key', 'k-1').send(body(team));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(await rows('SELECT 1 FROM work_items')).toHaveLength(1);
    expect(await rows('SELECT 1 FROM activity_events')).toHaveLength(1);
  });

  it('6 parallel requests with the same key still create exactly one item', async () => {
    const u = await makeUser('Dana', { [team]: 'member' });
    const res = await Promise.all(
      Array.from({ length: 6 }, () => api().post('/api/items').set(as(u)).set('Idempotency-Key', 'burst').send(body(team))),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
    expect(await rows('SELECT 1 FROM work_items')).toHaveLength(1);
  });

  it('reusing a key with a different payload is rejected (422)', async () => {
    const u = await makeUser('Dana', { [team]: 'member' });
    await api().post('/api/items').set(as(u)).set('Idempotency-Key', 'k-2').send(body(team));
    const r = await api().post('/api/items').set(as(u)).set('Idempotency-Key', 'k-2').send({ ...body(team), title: 'Different' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_key_reuse');
    expect(await rows('SELECT 1 FROM work_items')).toHaveLength(1);
  });

  it('without a key, two requests are two items (control)', async () => {
    const u = await makeUser('Dana', { [team]: 'member' });
    await api().post('/api/items').set(as(u)).send(body(team));
    await api().post('/api/items').set(as(u)).send(body(team));
    expect(await rows('SELECT 1 FROM work_items')).toHaveLength(2);
  });

  it('a retried claim replays the first response instead of failing with 409', async () => {
    const creator = await makeUser('Creator', { [team]: 'member' });
    const u = await makeUser('Dana', { [team]: 'member' });
    const item = await newItem(creator, team);
    const a = await api().post(`/api/items/${item.id}/claim`).set(as(u)).set('Idempotency-Key', 'c-1');
    const b = await api().post(`/api/items/${item.id}/claim`).set(as(u)).set('Idempotency-Key', 'c-1');
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect(await rows(`SELECT 1 FROM activity_events WHERE type = 'claimed'`)).toHaveLength(1);
  });

  it('a failed first attempt does not poison the key', async () => {
    const viewer = await makeUser('Vic', { [team]: 'viewer' });
    const bad = await api().post('/api/items').set(as(viewer)).set('Idempotency-Key', 'k-3').send(body(team));
    expect(bad.status).toBe(403);
    expect(await rows('SELECT 1 FROM idempotency_keys')).toHaveLength(0);
  });
});
