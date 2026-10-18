import { beforeEach, describe, expect, it } from 'vitest';
import { api, as, makeTeam, makeUser, newItem, resetDb, type TestUser } from './helpers';

let team: string;
let member: TestUser, member2: TestUser, lead: TestUser;
beforeEach(async () => {
  await resetDb();
  team = await makeTeam('Compliance');
  member = await makeUser('Mia Member', { [team]: 'member' });
  member2 = await makeUser('Max Member', { [team]: 'member' });
  lead = await makeUser('Lena Lead', { [team]: 'lead' });
});

const move = (u: TestUser, id: string, to: string, extra = {}) =>
  api().post(`/api/items/${id}/transition`).set(as(u)).send({ to, ...extra });

describe('workflow rules (server-enforced)', () => {
  it('rejects an invalid jump (Open -> Closed) with 422', async () => {
    const item = await newItem(member, team);
    const r = await move(lead, item.id, 'closed');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('invalid_transition');
  });

  it('requires the item to be claimed before work starts', async () => {
    const item = await newItem(member, team);
    const r = await move(member, item.id, 'in_progress');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('assignee_required');
  });

  it('only a Lead can approve; members (even the assignee) get 403', async () => {
    const item = await newItem(member, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(member));
    expect((await move(member, item.id, 'in_progress')).status).toBe(200);
    expect((await move(member, item.id, 'awaiting_approval')).status).toBe(200);

    const selfApprove = await move(member, item.id, 'resolved');
    expect(selfApprove.status).toBe(403);
    expect((await move(member2, item.id, 'resolved')).status).toBe(403);

    const approved = await move(lead, item.id, 'resolved');
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('resolved');
  });

  it('a member who is not the assignee cannot move the item', async () => {
    const item = await newItem(member, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(member));
    const r = await move(member2, item.id, 'in_progress');
    expect(r.status).toBe(403);
  });

  it('closed is terminal, and closed items cannot be edited', async () => {
    const item = await newItem(member, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(member));
    for (const [u, to] of [[member, 'in_progress'], [member, 'awaiting_approval'], [lead, 'resolved'], [lead, 'closed']] as const) {
      expect((await move(u, item.id, to)).status).toBe(200);
    }
    expect((await move(lead, item.id, 'in_progress')).status).toBe(422);
    const closed = (await api().get(`/api/items/${item.id}`).set(as(lead))).body;
    const edit = await api().patch(`/api/items/${item.id}`).set(as(lead)).send({ version: closed.version, title: 'nope' });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('item_closed');
  });

  it('a transition with a stale version is a 409 carrying the latest item', async () => {
    const item = await newItem(member, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(member)); // item is now v2
    const r = await move(member, item.id, 'in_progress', { version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.latest.version).toBe(2);
  });

  it('records every state / owner / priority change and comment in the activity log', async () => {
    const item = await newItem(member, team);
    await api().post(`/api/items/${item.id}/claim`).set(as(member));
    await api().patch(`/api/items/${item.id}`).set(as(member)).send({ version: 2, priority: 'urgent', title: 'Renamed' });
    await move(member, item.id, 'in_progress');
    await api().post(`/api/items/${item.id}/comments`).set(as(member)).send({ body: 'Working on it' }).expect(201);

    const log = (await api().get(`/api/items/${item.id}/activity`).set(as(member))).body.events;
    const types = log.map((e: any) => e.type).reverse();
    expect(types).toEqual(['created', 'claimed', 'priority_changed', 'item_updated', 'status_changed', 'comment_added']);
    expect(log[0].comment_body).toBe('Working on it');
    expect(log.find((e: any) => e.type === 'priority_changed').data).toEqual({ from: 'medium', to: 'urgent' });
    expect(log.find((e: any) => e.type === 'status_changed').data).toEqual({ from: 'open', to: 'in_progress' });
  });
});
