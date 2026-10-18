import crypto from 'node:crypto';
import type { Tx } from './db';
import { HttpError } from './errors';

export interface Result { status: number; body: unknown }

/**
 * Idempotency-Key support for POST requests.
 *
 * The key row is inserted INSIDE the same transaction as the business change:
 *  - first request: insert succeeds, handler runs, response saved, everything commits together.
 *  - concurrent duplicate: its INSERT blocks on the unique index until the first transaction ends,
 *    then sees the stored response and replays it. No double-create, even for parallel retries.
 *  - first request failed/rolled back: key row vanishes too, so a retry simply runs again.
 */
export async function withIdempotency(
  c: Tx,
  userId: string,
  key: string | undefined,
  fingerprint: object,
  handler: () => Promise<Result>,
): Promise<Result & { replayed: boolean }> {
  if (!key) return { ...(await handler()), replayed: false };
  if (key.length > 200) throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key too long');

  const hash = crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
  const ins = await c.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [userId, key, hash],
  );

  if (ins.rowCount === 1) {
    const result = await handler();
    await c.query(
      'UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2',
      [userId, key, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  }

  const prev = (await c.query(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
    [userId, key],
  )).rows[0];
  if (prev.request_hash !== hash) {
    throw new HttpError(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used with a different request');
  }
  return { status: prev.status_code, body: prev.response, replayed: true };
}
