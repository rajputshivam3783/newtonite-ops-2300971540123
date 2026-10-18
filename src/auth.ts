import type { NextFunction, Request, RequestHandler, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { pool } from './db';
import { HttpError } from './errors';
import type { AuthUser, Role } from './permissions';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (userId: string) =>
  jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '8h' });

/** Roles are loaded from the DB on every request, so a role change applies immediately. */
export async function loadUser(userId: string): Promise<AuthUser | null> {
  const u = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [userId]);
  if (!u.rows[0]) return null;
  const m = await pool.query('SELECT team_id, role FROM memberships WHERE user_id = $1', [userId]);
  return {
    ...u.rows[0],
    roles: new Map<string, Role>(m.rows.map((r) => [r.team_id, r.role])),
  };
}

export async function login(email: string, password: string) {
  const r = await pool.query('SELECT id, password_hash FROM users WHERE lower(email) = lower($1)', [email]);
  const row = r.rows[0];
  // compare even when the user is missing so response time doesn't reveal valid emails
  const ok = await bcrypt.compare(password, row?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!row || !ok) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  return { token: signToken(row.id), user: await loadUser(row.id) };
}

export const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const header = req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'unauthenticated', 'Missing bearer token');
    let sub: string;
    try {
      sub = (jwt.verify(token, config.jwtSecret) as { sub: string }).sub;
    } catch {
      throw new HttpError(401, 'unauthenticated', 'Invalid or expired token');
    }
    const user = await loadUser(sub);
    if (!user) throw new HttpError(401, 'unauthenticated', 'User no longer exists');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
};
