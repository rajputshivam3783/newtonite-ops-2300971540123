// UI smoke tests: the real index.html runs in jsdom against the real API + Postgres.
import { JSDOM } from 'jsdom';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, app, as, makeTeam, makeUser, newItem, resetDb, rows, type TestUser } from './helpers';
import fs from 'node:fs';

let server: ReturnType<typeof app.listen>;
let base: string;
beforeAll(() => new Promise<void>((r) => { server = app.listen(0, () => { base = `http://localhost:${(server.address() as AddressInfo).port}`; r(); }); }));
afterAll(() => { server.close(); });

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

async function openUi(user: TestUser) {
  const dom = new JSDOM(html, {
    url: base + '/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.localStorage.setItem('token', user.token);
      w.fetch = (u: string, o: any) => fetch(base + u, o);
    },
  });
  return dom.window as any;
}
const waitFor = async (fn: () => any, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) { try { const v = fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) throw new Error('waitFor timed out: ' + fn); await new Promise((r) => setTimeout(r, 25)); }
};
const btn = (w: any, text: string) => [...w.document.querySelectorAll('button')].find((b: any) => b.textContent.trim() === text) as HTMLButtonElement | undefined;

let team: string, creator: TestUser, alice: TestUser, bob: TestUser;
beforeEach(async () => {
  await resetDb();
  team = await makeTeam('Payments Ops');
  creator = await makeUser('Creator', { [team]: 'member' });
  alice = await makeUser('Alice', { [team]: 'member' });
  bob = await makeUser('Bob', { [team]: 'member' });
});

describe('frontend', () => {
  it('shows dashboard counts and a paginated list, with "Load more"', async () => {
    await newItem(creator, team, { title: 'Urgent one', priority: 'urgent' });
    for (let i = 0; i < 30; i++) await newItem(creator, team, { title: `Filler ${i}` });
    const w = await openUi(alice);
    await waitFor(() => w.document.querySelectorAll('tr.row').length === 25);
    await waitFor(() => w.document.getElementById('tabs').textContent.includes('Unassigned urgent1'));
    btn(w, 'Load more')!.click();
    await waitFor(() => w.document.querySelectorAll('tr.row').length === 31);
    expect(btn(w, 'Load more')).toBeUndefined();
  });

  it('claim: optimistic update, then reconciled with the server', async () => {
    const item = await newItem(creator, team, { title: 'Claim me' });
    const w = await openUi(alice);
    await waitFor(() => w.document.querySelector('tr.row'));
    w.document.querySelector('tr.row').click();
    await waitFor(() => btn(w, 'Claim'));
    btn(w, 'Claim')!.click();
    await waitFor(() => w.document.getElementById('detail').textContent.includes('Assignee: Alice'));
    // the optimistic state appears immediately; the activity entry only exists once the server confirmed
    await waitFor(() => w.document.getElementById('detail').textContent.includes('Alice') && w.document.querySelector('.timeline')?.textContent.includes('claimed it'));
    expect((await rows('SELECT assignee_id FROM work_items WHERE id=$1', [item.id]))[0].assignee_id).toBe(alice.id);
    expect(btn(w, 'Claim')).toBeUndefined();
  });

  it('lost race: UI rolls back, explains why, and shows the real owner', async () => {
    const item = await newItem(creator, team, { title: 'Contested' });
    const w = await openUi(alice);
    await waitFor(() => w.document.querySelector('tr.row'));
    w.document.querySelector('tr.row').click();
    await waitFor(() => btn(w, 'Claim'));
    // Bob wins the race while Alice's screen still shows the item as unclaimed
    await api().post(`/api/items/${item.id}/claim`).set(as(bob)).expect(200);
    btn(w, 'Claim')!.click();
    await waitFor(() => w.document.getElementById('detail').textContent.includes('already claimed'));
    await waitFor(() => w.document.getElementById('detail').textContent.includes('Assignee: Bob'));
    expect(btn(w, 'Claim')).toBeUndefined();
    expect((await rows('SELECT assignee_id FROM work_items WHERE id=$1', [item.id]))[0].assignee_id).toBe(bob.id);
  });

  it('stale edit: UI shows "this item changed, reload" and the server data is untouched', async () => {
    const item = await newItem(creator, team, { title: 'Editable' });
    const w = await openUi(alice);
    await waitFor(() => w.document.querySelector('tr.row'));
    w.document.querySelector('tr.row').click();
    await waitFor(() => w.document.querySelector('details input'));
    await api().patch(`/api/items/${item.id}`).set(as(bob)).send({ version: 1, title: 'Changed by Bob' }).expect(200);
    const input = w.document.querySelector('details input');
    input.value = 'Alice edit'; input.dispatchEvent(new w.Event('input'));
    btn(w, 'Save changes')!.click();
    await waitFor(() => w.document.getElementById('detail').textContent.includes('This item changed since you opened it'));
    expect(btn(w, 'Reload latest version')).toBeTruthy();
    expect((await rows('SELECT title FROM work_items WHERE id=$1', [item.id]))[0].title).toBe('Changed by Bob');
    btn(w, 'Reload latest version')!.click();
    await waitFor(() => w.document.querySelector('.title-big')?.textContent === 'Changed by Bob');
  });

  it('user-supplied text is rendered as text, never as HTML', async () => {
    await newItem(creator, team, { title: '<img src=x onerror="window.pwned=1"> hi', description: '<script>window.pwned=1</script>' });
    const w = await openUi(alice);
    await waitFor(() => w.document.querySelector('tr.row'));
    w.document.querySelector('tr.row').click();
    await waitFor(() => w.document.querySelector('.title-big'));
    expect(w.document.querySelector('img')).toBeNull();
    expect(w.document.querySelector('.title-big').textContent).toContain('<img src=x');
    expect(w.pwned).toBeUndefined();
  });

  it('viewers get a read-only UI (and the server would refuse anyway)', async () => {
    const vic = await makeUser('Vic', { [team]: 'viewer' });
    await newItem(creator, team);
    const w = await openUi(vic);
    await waitFor(() => w.document.querySelector('tr.row'));
    expect(btn(w, '+ New item')!.disabled).toBe(true);
    w.document.querySelector('tr.row').click();
    await waitFor(() => w.document.getElementById('detail').textContent.includes('Read-only'));
    expect(btn(w, 'Claim')).toBeUndefined();
  });

  it('creating an item twice (double-click) yields one item', async () => {
    const w = await openUi(alice);
    await waitFor(() => btn(w, '+ New item'));
    btn(w, '+ New item')!.click();
    const modal = await waitFor(() => w.document.querySelector('.modal'));
    const title = modal.querySelector('input'); title.value = 'Dbl click'; title.dispatchEvent(new w.Event('input'));
    const create = btn(w, 'Create')!;
    create.click(); create.click();
    await waitFor(() => w.document.querySelector('.title-big')?.textContent === 'Dbl click');
    expect(await rows(`SELECT 1 FROM work_items WHERE title='Dbl click'`)).toHaveLength(1);
  });
});
