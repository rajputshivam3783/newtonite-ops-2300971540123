import bcrypt from 'bcryptjs';
import { pool } from './db';
import { migrate } from './migrate';

export const DEMO_PASSWORD = 'password123';

const TEAMS = ['Payments Ops', 'Customer Support', 'Compliance', 'Platform Incidents'] as const;
type T = (typeof TEAMS)[number];

// [name, email, [[team, role], ...]]
const USERS: [string, string, [T, string][]][] = [
  ['Asha Admin',   'admin@ops.test',  TEAMS.map((t) => [t, 'admin'] as [T, string])],
  ['Priya Lead',   'priya@ops.test',  [['Payments Ops', 'lead'], ['Customer Support', 'member']]],
  ['Rahul Lead',   'rahul@ops.test',  [['Customer Support', 'lead'], ['Compliance', 'lead']]],
  ['Neha Lead',    'neha@ops.test',   [['Platform Incidents', 'lead'], ['Payments Ops', 'member']]],
  ['Amit Member',  'amit@ops.test',   [['Payments Ops', 'member'], ['Customer Support', 'member']]],
  ['Sara Member',  'sara@ops.test',   [['Customer Support', 'member']]],
  ['Dev Member',   'dev@ops.test',    [['Platform Incidents', 'member'], ['Compliance', 'member']]],
  ['Kiran Member', 'kiran@ops.test',  [['Compliance', 'member']]],
  ['Vik Viewer',   'vik@ops.test',    [['Payments Ops', 'viewer'], ['Customer Support', 'viewer']]],
  ['Maya Viewer',  'maya@ops.test',   [['Compliance', 'viewer']]],
];

export async function seed(itemCount = 5000) {
  const existing = await pool.query('SELECT count(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) return { skipped: true };

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const teamIds = new Map<string, string>();
    for (const t of TEAMS) {
      teamIds.set(t, (await c.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [t])).rows[0].id);
    }
    for (const [name, email, teams] of USERS) {
      const id = (await c.query('INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [name, email, hash])).rows[0].id;
      for (const [t, role] of teams) {
        await c.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1,$2,$3)', [id, teamIds.get(t), role]);
      }
    }

    // Bulk sample data (deterministic): a few thousand items spread over the last ~60 days.
    await c.query('SELECT setseed(0.42)');
    await c.query(
      `WITH ts AS (SELECT array_agg(id ORDER BY id) AS ids FROM teams),
       gen AS (
         SELECT g,
                ts.ids[1 + floor(random()*cardinality(ts.ids))::int] AS team_id,
                (ARRAY['incident','customer_issue','payment','compliance','task'])[1+floor(random()*5)::int] AS type,
                (ARRAY['low','medium','medium','high','urgent'])[1+floor(random()*5)::int] AS priority,
                (ARRAY['open','open','open','in_progress','in_progress','awaiting_approval','resolved','closed'])[1+floor(random()*8)::int] AS status,
                now() - (g * interval '17 minutes') AS created_at
         FROM generate_series(1, $1) g CROSS JOIN ts
       ), ins AS (
         INSERT INTO work_items (team_id, title, description, type, priority, status, assignee_id, created_by, due_date, created_at, updated_at)
         SELECT gen.team_id,
                initcap(replace(gen.type,'_',' ')) || ' #' || gen.g || ': ' ||
                  (ARRAY['payment gateway timeout','refund stuck','KYC document mismatch','duplicate charge','login failures',
                         'audit report overdue','chargeback dispute','API latency spike','data export request','settlement delay'])[1+floor(random()*10)::int],
                'Sample item generated for demo and pagination testing.',
                gen.type, gen.priority, gen.status,
                CASE WHEN gen.status = 'open' AND random() < 0.7 THEN NULL
                     ELSE (SELECT m.user_id FROM memberships m WHERE m.team_id = gen.team_id AND m.role IN ('member','lead')
                           ORDER BY m.user_id OFFSET floor(random()*2)::int LIMIT 1) END,
                (SELECT m.user_id FROM memberships m WHERE m.team_id = gen.team_id AND m.role IN ('member','lead','admin')
                 ORDER BY m.user_id LIMIT 1),
                (current_date + (floor(random()*30) - 5)::int),
                gen.created_at, gen.created_at
         FROM gen
         RETURNING id, created_by, created_at, title, type, priority
       )
       INSERT INTO activity_events (item_id, actor_id, type, data, created_at)
       SELECT id, created_by, 'created', jsonb_build_object('title', title, 'type', type, 'priority', priority), created_at FROM ins`,
      [itemCount],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { skipped: false, itemCount };
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => seed())
    .then((r) => { console.log(r.skipped ? 'Seed skipped: database already has users' : `Seeded ${r.itemCount} items`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
