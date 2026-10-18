import type { Tx } from './db';

export type Handler = (c: Tx, job: { id: number; payload: any }) => Promise<void>;

/**
 * Handlers must be idempotent: a job can legitimately run more than once
 * (crash after the side effect, before the job was marked done).
 * Here idempotency comes from notifications.dedupe_key UNIQUE + ON CONFLICT DO NOTHING.
 */
async function notify(c: Tx, jobId: number, userId: string, itemId: string, message: string) {
  await c.query(
    `INSERT INTO notifications (user_id, item_id, message, dedupe_key) VALUES ($1,$2,$3,$4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [userId, itemId, message, `job:${jobId}:user:${userId}`],
  );
}

export const handlers: Record<string, Handler> = {
  // Tell the creator that someone picked their item up (skip if they claimed their own).
  async item_claimed(c, job) {
    const { item_id, actor_id } = job.payload;
    const r = await c.query(
      `SELECT w.title, w.created_by, u.name AS actor FROM work_items w, users u WHERE w.id = $1 AND u.id = $2`,
      [item_id, actor_id],
    );
    const row = r.rows[0];
    if (!row || row.created_by === actor_id) return;
    await notify(c, job.id, row.created_by, item_id, `${row.actor} claimed "${row.title}"`);
  },

  // Tell every lead/admin of the item's team that approval is needed.
  async approval_requested(c, job) {
    const { item_id, actor_id } = job.payload;
    const r = await c.query(
      `SELECT w.title, m.user_id FROM work_items w
       JOIN memberships m ON m.team_id = w.team_id AND m.role IN ('lead','admin')
       WHERE w.id = $1 AND m.user_id <> $2`,
      [item_id, actor_id],
    );
    for (const row of r.rows) {
      await notify(c, job.id, row.user_id, item_id, `Approval requested: "${row.title}"`);
    }
  },
};
