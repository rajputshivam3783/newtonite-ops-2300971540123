import { beforeEach, describe, expect, it } from 'vitest';
import { api, as, makeTeam, makeUser, newItem, resetDb, rows, type TestUser } from './helpers';
import { pool } from '../src/db';

let teamA: string, teamB: string;
let alice: TestUser, outsider: TestUser, viewer: TestUser;
let itemId: string;

beforeEach(async () => {
  await resetDb();
  teamA = await makeTeam('Team A');
  teamB = await makeTeam('Team B');
  alice = await makeUser('Alice', { [teamA]: 'member' });
  outsider = await makeUser('Olga Outsider', { [teamB]: 'lead' }); // lead, but of the OTHER team
  viewer = await makeUser('Vic Viewer', { [teamA]: 'viewer' });
  itemId = (await newItem(alice, teamA)).id;
});

describe('resource-level authorization', () => {
  it('a user from another team gets 404 on every read and write (even as a lead elsewhere)', async () => {
    const o = as(outsider);
    expect((await api().get(`/api/items/${itemId}`).set(o)).status).toBe(404);
    expect((await api().get(`/api/items/${itemId}/activity`).set(o)).status).toBe(404);
    expect((await api().patch(`/api/items/${itemId}`).set(o).send({ version: 1, title: 'x' })).status).toBe(404);
    expect((await api().post(`/api/items/${itemId}/claim`).set(o)).status).toBe(404);
    expect((await api().post(`/api/items/${itemId}/transition`).set(o).send({ to: 'in_progress' })).status).toBe(404);
    expect((await api().post(`/api/items/${itemId}/comments`).set(o).send({ body: 'hi' })).status).toBe(404);
    // and nothing changed
    const [row] = await rows('SELECT assignee_id, title, version FROM work_items WHERE id = $1', [itemId]);
    expect(row).toMatchObject({ assignee_id: null, title: 'Test item', version: 1 });
  });

  it('creating an item in a team you do not belong to is 403', async () => {
    const r = await api().post('/api/items').set(as(outsider)).send({ team_id: teamA, title: 'x', type: 'task' });
    expect(r.status).toBe(403);
    expect(await rows('SELECT 1 FROM work_items')).toHaveLength(1);
  });

  it('lists and counts never include other teams\' items, even when asked for them', async () => {
    const list = await api().get('/api/items').set(as(outsider));
    expect(list.body.items).toHaveLength(0);
    const forced = await api().get(`/api/items?team_id=${teamA}`).set(as(outsider));
    expect(forced.body.items).toHaveLength(0);
    const own = await api().get('/api/items').set(as(alice));
    expect(own.body.items).toHaveLength(1);
  });

  it('viewers can read but not write (403)', async () => {
    const v = as(viewer);
    expect((await api().get(`/api/items/${itemId}`).set(v)).status).toBe(200);
    expect((await api().post(`/api/items/${itemId}/claim`).set(v)).status).toBe(403);
    expect((await api().post(`/api/items/${itemId}/comments`).set(v).send({ body: 'hi' })).status).toBe(403);
    expect((await api().patch(`/api/items/${itemId}`).set(v).send({ version: 1, title: 'x' })).status).toBe(403);
    expect((await api().post('/api/items').set(v).send({ team_id: teamA, title: 'x', type: 'task' })).status).toBe(403);
    const detail = (await api().get(`/api/items/${itemId}`).set(v)).body;
    expect(detail.allowed).toMatchObject({ edit: false, claim: false, comment: false, transitions: [] });
  });

  it('role changes apply immediately (roles are read from the DB, not the token)', async () => {
    expect((await api().get(`/api/items/${itemId}`).set(as(viewer))).status).toBe(200);
    await pool.query('DELETE FROM memberships WHERE user_id = $1', [viewer.id]);
    expect((await api().get(`/api/items/${itemId}`).set(as(viewer))).status).toBe(404);
  });

  it('"awaiting my approval" only covers teams where I am lead/admin', async () => {
    const leadA = await makeUser('Lena', { [teamA]: 'lead' });
    const memberB = await makeUser('Bob', { [teamB]: 'member', [teamA]: 'member' });
    // move the item to awaiting_approval
    await api().post(`/api/items/${itemId}/claim`).set(as(alice));
    await api().post(`/api/items/${itemId}/transition`).set(as(alice)).send({ to: 'in_progress' });
    await api().post(`/api/items/${itemId}/transition`).set(as(alice)).send({ to: 'awaiting_approval' });

    const forLead = await api().get('/api/items?view=awaiting_my_approval').set(as(leadA));
    expect(forLead.body.items.map((i: any) => i.id)).toEqual([itemId]);
    const forMember = await api().get('/api/items?view=awaiting_my_approval').set(as(memberB));
    expect(forMember.body.items).toHaveLength(0);
    expect((await api().get('/api/dashboard').set(as(leadA))).body.awaiting_my_approval).toBe(1);
    expect((await api().get('/api/dashboard').set(as(memberB))).body.awaiting_my_approval).toBe(0);
  });

  it('requires authentication, and rejects bad tokens / ids', async () => {
    expect((await api().get('/api/items')).status).toBe(401);
    expect((await api().get('/api/items').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await api().get('/api/items/not-a-uuid').set(as(alice))).status).toBe(404);
  });

  it('login works with the right password only', async () => {
    const ok = await api().post('/api/auth/login').send({ email: alice.email, password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.user).not.toHaveProperty('password_hash');
    expect((await api().post('/api/auth/login').send({ email: alice.email, password: 'wrong' })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: 'nobody@x.y', password: 'x' })).status).toBe(401);
  });

  it('validates input (unknown fields, bad enums) with 400', async () => {
    const r = await api().post('/api/items').set(as(alice)).send({ team_id: teamA, title: '', type: 'bogus' });
    expect(r.status).toBe(400);
    const extra = await api().patch(`/api/items/${itemId}`).set(as(alice)).send({ version: 1, assignee_id: alice.id });
    expect(extra.status).toBe(400); // assignment only via /claim
  });
});
