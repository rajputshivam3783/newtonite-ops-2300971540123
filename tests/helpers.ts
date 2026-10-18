import bcrypt from 'bcryptjs';
import request from 'supertest';
import { signToken } from '../src/auth';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import type { Role } from '../src/permissions';

export const app = createApp();
export const api = () => request(app);

export async function resetDb() {
  await pool.query(
    `TRUNCATE users, teams, memberships, work_items, activity_events, comments,
              idempotency_keys, jobs, notifications RESTART IDENTITY CASCADE`,
  );
}

export async function makeTeam(name: string): Promise<string> {
  return (await pool.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
}

export interface TestUser { id: string; email: string; token: string }

export async function makeUser(name: string, roles: Record<string, Role> = {}): Promise<TestUser> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@test.local`;
  const hash = await bcrypt.hash('password123', 4);
  const id = (await pool.query(
    'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [name, email, hash],
  )).rows[0].id;
  for (const [team, role] of Object.entries(roles)) {
    await pool.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1,$2,$3)', [id, team, role]);
  }
  return { id, email, token: signToken(id) };
}

export const as = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

export async function newItem(u: TestUser, team: string, extra: Record<string, unknown> = {}) {
  const res = await api().post('/api/items').set(as(u)).send({ team_id: team, title: 'Test item', type: 'incident', ...extra });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
