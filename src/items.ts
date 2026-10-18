import { z } from 'zod';
import { pool, type Tx } from './db';
import { HttpError, notFound } from './errors';
import {
  assertCan,
  assertCanTransition,
  checkTransition,
  roleAtLeast,
  type AuthUser,
} from './permissions';
import { ACTIVE_STATUSES, PRIORITIES, STATUSES, TRANSITIONS, TYPES, type Status } from './workflow';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);

// ---------- input schemas ----------
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD').nullable();

export const createSchema = z.object({
  team_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(''),
  type: z.enum(TYPES),
  priority: z.enum(PRIORITIES).default('medium'),
  due_date: dueDate.optional(),
}).strict();

export const updateSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  type: z.enum(TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: dueDate.optional(),
}).strict();

export const transitionSchema = z.object({
  to: z.enum(STATUSES),
  version: z.number().int().positive().optional(),
}).strict();

export const commentSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();

export const listSchema = z.object({
  view: z.enum(['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval']).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TYPES).optional(),
  team_id: z.string().uuid().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});

// ---------- helpers ----------
const ITEM_SELECT = `
  SELECT w.id, w.team_id, t.name AS team_name, w.title, w.description, w.type, w.priority, w.status,
         w.assignee_id, a.name AS assignee_name, w.created_by, cb.name AS created_by_name,
         w.due_date, w.version, w.created_at, w.updated_at
  FROM work_items w
  JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id
  JOIN users cb ON cb.id = w.created_by`;

type Q = Tx | typeof pool;

async function viewById(c: Q, id: string) {
  const r = await c.query(`${ITEM_SELECT} WHERE w.id = $1`, [id]);
  return r.rows[0];
}

async function logEvent(c: Tx, itemId: string, actorId: string, type: string, data: object = {}) {
  await c.query('INSERT INTO activity_events (item_id, actor_id, type, data) VALUES ($1,$2,$3,$4)', [
    itemId, actorId, type, JSON.stringify(data),
  ]);
}

/** Transactional outbox: the job row commits (or rolls back) together with the change. */
async function enqueue(c: Tx, type: string, payload: object) {
  await c.query('INSERT INTO jobs (type, payload) VALUES ($1,$2)', [type, JSON.stringify(payload)]);
}

async function conflict(c: Tx, id: string, code: string, message: string): Promise<HttpError> {
  return new HttpError(409, code, message, { latest: await viewById(c, id) });
}

/** Load the raw row + run the permission check for the item's team. Non-members get 404. */
async function loadForAction(c: Tx, user: AuthUser, id: string, action: Parameters<typeof assertCan>[2]) {
  if (!isUuid(id)) throw notFound();
  const r = await c.query('SELECT * FROM work_items WHERE id = $1', [id]);
  const item = r.rows[0];
  if (!item) throw notFound();
  assertCan(user, item.team_id, action, { conceal: true });
  return item;
}

/** What the UI may offer. The server still re-checks everything on each request. */
function allowedFor(user: AuthUser, item: any) {
  const role = user.roles.get(item.team_id);
  const member = roleAtLeast(role, 'member');
  const transitions = member
    ? Object.entries(TRANSITIONS[item.status as Status])
        .filter(([, rule]) => checkTransition(user, item, rule!) === 'ok')
        .map(([to, rule]) => ({ to, label: rule!.label }))
    : [];
  return {
    role,
    edit: member && item.status !== 'closed',
    claim: member && !item.assignee_id && ACTIVE_STATUSES.includes(item.status),
    comment: member,
    transitions,
  };
}

// ---------- commands (each runs inside a caller-provided transaction) ----------
export async function createItem(c: Tx, user: AuthUser, input: z.infer<typeof createSchema>) {
  assertCan(user, input.team_id, 'item:create'); // 403 (caller named the team, nothing to conceal)
  const r = await c.query(
    `INSERT INTO work_items (team_id, title, description, type, priority, due_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.team_id, input.title, input.description, input.type, input.priority, input.due_date ?? null, user.id],
  );
  const id = r.rows[0].id;
  await logEvent(c, id, user.id, 'created', { title: input.title, type: input.type, priority: input.priority });
  return viewById(c, id);
}

export async function updateItem(c: Tx, user: AuthUser, id: string, input: z.infer<typeof updateSchema>) {
  const item = await loadForAction(c, user, id, 'item:update');
  if (item.status === 'closed') throw new HttpError(422, 'item_closed', 'Closed items cannot be edited');
  if (item.version !== input.version) {
    throw await conflict(c, id, 'stale_version', 'This item changed since you loaded it');
  }

  const fields = ['title', 'description', 'type', 'priority', 'due_date'] as const;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (input[f] !== undefined && input[f] !== item[f]) changes[f] = { from: item[f], to: input[f] };
  }
  if (Object.keys(changes).length === 0) return viewById(c, id); // no-op: don't bump version

  const names = Object.keys(changes);
  const sets = names.map((f, i) => `${f} = $${i + 3}`).join(', ');
  // The version in the WHERE clause is the actual lock: a concurrent writer makes this match 0 rows.
  const res = await c.query(
    `UPDATE work_items SET ${sets}, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [id, input.version, ...names.map((f) => changes[f].to)],
  );
  if (res.rowCount === 0) throw await conflict(c, id, 'stale_version', 'This item changed since you loaded it');

  const { priority, ...rest } = changes;
  if (priority) await logEvent(c, id, user.id, 'priority_changed', priority);
  if (Object.keys(rest).length) await logEvent(c, id, user.id, 'item_updated', { changes: rest });
  return viewById(c, id);
}

export async function claimItem(c: Tx, user: AuthUser, id: string) {
  const item = await loadForAction(c, user, id, 'item:claim');
  if (!ACTIVE_STATUSES.includes(item.status)) {
    throw new HttpError(422, 'item_not_claimable', `A ${item.status} item cannot be claimed`);
  }
  // Atomic claim: only one concurrent caller can flip assignee_id from NULL.
  const res = await c.query(
    `UPDATE work_items SET assignee_id = $2, version = version + 1, updated_at = now()
     WHERE id = $1 AND assignee_id IS NULL AND status IN ('open','in_progress','awaiting_approval')`,
    [id, user.id],
  );
  if (res.rowCount === 0) throw await conflict(c, id, 'already_claimed', 'Someone else already claimed this item');

  await logEvent(c, id, user.id, 'claimed', { assignee_id: user.id });
  await enqueue(c, 'item_claimed', { item_id: id, actor_id: user.id });
  return viewById(c, id);
}

export async function transitionItem(c: Tx, user: AuthUser, id: string, input: z.infer<typeof transitionSchema>) {
  const item = await loadForAction(c, user, id, 'item:transition');
  assertCanTransition(user, item, input.to); // 422 invalid jump / 403 wrong role
  if (input.version !== undefined && input.version !== item.version) {
    throw await conflict(c, id, 'stale_version', 'This item changed since you loaded it');
  }
  const res = await c.query(
    `UPDATE work_items SET status = $3, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [id, item.version, input.to],
  );
  if (res.rowCount === 0) throw await conflict(c, id, 'stale_version', 'This item changed while you were acting on it');

  await logEvent(c, id, user.id, 'status_changed', { from: item.status, to: input.to });
  if (input.to === 'awaiting_approval') await enqueue(c, 'approval_requested', { item_id: id, actor_id: user.id });
  return viewById(c, id);
}

export async function addComment(c: Tx, user: AuthUser, id: string, body: string) {
  await loadForAction(c, user, id, 'item:comment');
  const r = await c.query(
    'INSERT INTO comments (item_id, author_id, body) VALUES ($1,$2,$3) RETURNING id, created_at',
    [id, user.id, body],
  );
  await logEvent(c, id, user.id, 'comment_added', { comment_id: r.rows[0].id });
  return { id: r.rows[0].id, item_id: id, body, author_id: user.id, created_at: r.rows[0].created_at };
}

// ---------- queries ----------
export async function getItem(user: AuthUser, id: string) {
  if (!isUuid(id)) throw notFound();
  const item = await viewById(pool, id);
  if (!item) throw notFound();
  assertCan(user, item.team_id, 'item:read', { conceal: true });
  return { ...item, allowed: allowedFor(user, item) };
}

export async function listActivity(user: AuthUser, id: string, opts: { before?: number; limit: number }) {
  await getItem(user, id); // permission + existence
  const params: unknown[] = [id];
  let where = 'e.item_id = $1';
  if (opts.before) { params.push(opts.before); where += ` AND e.id < $${params.length}`; }
  params.push(opts.limit + 1);
  const r = await pool.query(
    `SELECT e.id, e.type, e.data, e.created_at, e.actor_id, u.name AS actor_name, c.body AS comment_body
     FROM activity_events e
     JOIN users u ON u.id = e.actor_id
     LEFT JOIN comments c ON e.type = 'comment_added' AND c.id = (e.data->>'comment_id')::bigint
     WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length}`,
    params,
  );
  const events = r.rows.slice(0, opts.limit);
  return { events, next_before: r.rows.length > opts.limit ? events[events.length - 1].id : null };
}

type ListQuery = z.infer<typeof listSchema>;

/** Builds the WHERE clause. Every list/count is scoped to the caller's teams first. */
function buildFilter(user: AuthUser, f: Partial<ListQuery>) {
  const teams = [...user.roles.keys()];
  const params: unknown[] = [teams];
  const where: string[] = ['w.team_id = ANY($1::uuid[])'];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  const active = `w.status IN ('open','in_progress','awaiting_approval')`;

  if (f.view === 'assigned_to_me') { add('w.assignee_id = ?', user.id); where.push(active); }
  if (f.view === 'unassigned_urgent') where.push(`w.assignee_id IS NULL AND w.priority = 'urgent' AND ${active}`);
  if (f.view === 'awaiting_my_approval') {
    const leadTeams = [...user.roles].filter(([, r]) => roleAtLeast(r, 'lead')).map(([t]) => t);
    add(`w.status = 'awaiting_approval' AND w.team_id = ANY(?::uuid[])`, leadTeams);
  }
  if (f.status) add('w.status = ?', f.status);
  if (f.priority) add('w.priority = ?', f.priority);
  if (f.type) add('w.type = ?', f.type);
  if (f.team_id) add('w.team_id = ?', f.team_id);
  if (f.assignee === 'me') add('w.assignee_id = ?', user.id);
  else if (f.assignee === 'unassigned') where.push('w.assignee_id IS NULL');
  else if (f.assignee) add('w.assignee_id = ?', f.assignee);
  if (f.q) {
    params.push(f.q);
    const fts = `$${params.length}`;
    params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(w.search_vec @@ websearch_to_tsquery('simple', ${fts}) OR w.title ILIKE $${params.length})`);
  }
  return { where, params };
}

export async function listItems(user: AuthUser, q: ListQuery) {
  const { where, params } = buildFilter(user, q);
  if (q.cursor) {
    let cur: { c: string; i: string };
    try { cur = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()); } catch { cur = null as any; }
    if (!cur || typeof cur.c !== 'string' || !isUuid(cur.i ?? '')) {
      throw new HttpError(400, 'bad_cursor', 'Invalid cursor');
    }
    params.push(cur.c, cur.i);
    where.push(`(w.created_at, w.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await pool.query(
    `${ITEM_SELECT.replace('w.updated_at', 'w.updated_at, w.created_at::text AS _cts')}
     WHERE ${where.join(' AND ')}
     ORDER BY w.created_at DESC, w.id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, q.limit);
  const last = rows[rows.length - 1];
  // created_at is carried as TEXT so microsecond precision survives the round trip (JS Date would truncate).
  const next_cursor = r.rows.length > q.limit && last
    ? Buffer.from(JSON.stringify({ c: last._cts, i: last.id })).toString('base64url')
    : null;
  return { items: rows.map(({ _cts, ...item }) => item), next_cursor };
}

export async function dashboardCounts(user: AuthUser) {
  const count = async (view: ListQuery['view']) => {
    const { where, params } = buildFilter(user, { view });
    const r = await pool.query(`SELECT count(*)::int AS n FROM work_items w WHERE ${where.join(' AND ')}`, params);
    return r.rows[0].n as number;
  };
  const [assigned_to_me, unassigned_urgent, awaiting_my_approval] = await Promise.all([
    count('assigned_to_me'), count('unassigned_urgent'), count('awaiting_my_approval'),
  ]);
  return { assigned_to_me, unassigned_urgent, awaiting_my_approval };
}
