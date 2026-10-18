import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { authenticate, login } from './auth';
import { pool, tx } from './db';
import { HttpError } from './errors';
import { withIdempotency, type Result } from './idempotency';
import {
  addComment, claimItem, commentSchema, createItem, createSchema, dashboardCounts, getItem,
  listActivity, listItems, listSchema, transitionItem, transitionSchema, updateItem, updateSchema,
} from './items';

const ah = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

/** Runs a mutating POST in one transaction, honouring the Idempotency-Key header. */
async function mutate(req: Request, res: Response, run: (c: import('./db').Tx) => Promise<Result>) {
  const user = req.user!;
  const out = await tx((c) =>
    withIdempotency(c, user.id, req.header('Idempotency-Key'), { m: req.method, p: req.path, b: req.body }, () => run(c)),
  );
  if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(out.status).json(out.body);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', ah(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  app.post('/api/auth/login', ah(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'validation_error', 'email and password are required');
    }
    res.json(serializeLogin(await login(email, password)));
  }));

  const api = express.Router();
  api.use(authenticate);

  api.get('/me', ah(async (req, res) => {
    const u = req.user!;
    const teams = await pool.query(
      'SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.name',
      [u.id],
    );
    res.json({ id: u.id, email: u.email, name: u.name, teams: teams.rows });
  }));

  api.get('/dashboard', ah(async (req, res) => res.json(await dashboardCounts(req.user!))));

  api.get('/items', ah(async (req, res) => res.json(await listItems(req.user!, listSchema.parse(req.query)))));

  api.post('/items', ah(async (req, res) => {
    const input = createSchema.parse(req.body);
    await mutate(req, res, async (c) => ({ status: 201, body: await createItem(c, req.user!, input) }));
  }));

  api.get('/items/:id', ah(async (req, res) => res.json(await getItem(req.user!, req.params.id))));

  api.patch('/items/:id', ah(async (req, res) => {
    const input = updateSchema.parse(req.body);
    res.json(await tx((c) => updateItem(c, req.user!, req.params.id, input)));
  }));

  api.post('/items/:id/claim', ah(async (req, res) => {
    await mutate(req, res, async (c) => ({ status: 200, body: await claimItem(c, req.user!, req.params.id) }));
  }));

  api.post('/items/:id/transition', ah(async (req, res) => {
    const input = transitionSchema.parse(req.body);
    await mutate(req, res, async (c) => ({ status: 200, body: await transitionItem(c, req.user!, req.params.id, input) }));
  }));

  api.post('/items/:id/comments', ah(async (req, res) => {
    const { body } = commentSchema.parse(req.body);
    await mutate(req, res, async (c) => ({ status: 201, body: await addComment(c, req.user!, req.params.id, body) }));
  }));

  api.get('/items/:id/activity', ah(async (req, res) => {
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    if (before !== undefined && !Number.isInteger(before)) throw new HttpError(400, 'validation_error', 'bad before');
    res.json(await listActivity(req.user!, req.params.id, { before, limit }));
  }));

  api.get('/notifications', ah(async (req, res) => {
    const r = await pool.query(
      `SELECT id, item_id, message, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [req.user!.id],
    );
    res.json({ notifications: r.rows });
  }));

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Unknown endpoint')));

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(publicDir));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid input', issues: err.issues } });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Malformed JSON body' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  return app;
}

function serializeLogin(r: { token: string; user: Awaited<ReturnType<typeof import('./auth').loadUser>> }) {
  return { token: r.token, user: { id: r.user!.id, email: r.user!.email, name: r.user!.name } };
}
