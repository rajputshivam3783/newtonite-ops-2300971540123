# Operations Under Pressure

An internal web app to **create, assign, track and resolve operational work items across teams**
(Newtonite Software Engineering Challenge). Built as one tight vertical slice, with the effort spent on
correctness under concurrency, server-side authorization and an auditable history rather than on screens.

- Work items with a server-enforced workflow: `open -> in_progress -> awaiting_approval -> resolved -> closed` (approval is Lead-only)
- Team-based roles (viewer / member / lead / admin), enforced on the server per team and per resource
- Append-only activity log written in the same DB transaction as every change
- Dashboard: **Assigned to me**, **Unassigned urgent**, **Awaiting my approval** + search, filters, cursor pagination
- Reliable async work via a transactional outbox + worker

**Stack:** Node.js 22 + TypeScript, Express, PostgreSQL 16 (plain SQL via `pg`), zod, JWT; a dependency-free
vanilla-JS single-page UI; Vitest + Supertest + jsdom for tests; Docker Compose.

## Run it (one command)

Prerequisite: Docker with Compose.

```bash
docker compose up --build
```

Open **http://localhost:3000**. This starts Postgres, runs migrations, seeds demo data (4 teams, 10 users,
5,000 items), starts the API/UI and the background worker.

### Demo logins (password for all: `password123`)

| Email | Role(s) |
|---|---|
| `admin@ops.test` | admin in all 4 teams |
| `priya@ops.test` | **lead** in Payments Ops, member in Customer Support |
| `rahul@ops.test` | **lead** in Customer Support and Compliance |
| `neha@ops.test` | **lead** in Platform Incidents, member in Payments Ops |
| `amit@ops.test` | member in Payments Ops, Customer Support |
| `sara@ops.test` | member in Customer Support |
| `dev@ops.test` | member in Platform Incidents, Compliance |
| `kiran@ops.test` | member in Compliance |
| `vik@ops.test` | **viewer** in Payments Ops, Customer Support |
| `maya@ops.test` | **viewer** in Compliance |

Things worth trying: open the same item in two browsers as two members and press **Claim** in both;
edit an item in one tab after changing it in another; try to approve an item as a member vs. as a lead.

## Run the tests (one command)

Tests run against a real PostgreSQL (the concurrency behaviour is the point, so no mocks).

```bash
docker compose up -d db     # or any Postgres on localhost:5432 (user/password: postgres)
npm ci
npm test                    # creates the opsdb_test database and applies migrations automatically
npm run typecheck           # optional
```

Use another database with `TEST_DATABASE_URL=postgres://user:pass@host:5432/dbname npm test`.

| Test file | What it proves |
|---|---|
| `concurrency.test.ts` | 8 parallel claims -> exactly one wins; stale edit -> 409 + data unchanged; two simultaneous edits -> one 409; a rolled-back transaction leaves no event/job; history table is append-only |
| `idempotency.test.ts` | same key twice -> one item, same response; 6 parallel same-key requests -> one item; key reused with a different body -> 422; failed attempts don't burn the key |
| `workflow.test.ts` | invalid jump rejected; approval is Lead-only; assignee rules; closed is terminal; every change appears in the activity log |
| `authorization.test.ts` | other-team user gets 404 on every read/write (even as lead elsewhere); viewer is read-only; roles apply immediately; input validation |
| `outbox.test.ts` | job written with the change; job run twice -> one notification; retry with backoff -> `failed` after max attempts; failed handler's partial writes rolled back; parallel workers never double-process |
| `listing.test.ts` | cursor pagination (incl. identical timestamps) visits each row once; filters; full-text + substring search; query plan uses an index on 20k rows |
| `ui.test.ts` | real UI in jsdom against the real API: optimistic claim, rollback on lost race, "item changed, reload" on stale edit, XSS-safe rendering, read-only viewer UI, double-submit creates one item |

## Local development without Docker

```bash
cp .env.example .env            # then export the variables, or prefix commands with them
docker compose up -d db         # or your own Postgres
npm ci
npm run migrate && npm run seed
npm run dev                     # API + UI on :3000 (watch mode)
npm run worker                  # in a second terminal
```

## Architecture

```mermaid
flowchart LR
  B[Browser SPA<br/>vanilla JS, polling] -->|REST + JWT| A[Express API<br/>auth, permissions, validation]
  A -->|"one transaction per change:<br/>item + activity_event + outbox job + idempotency key"| P[(PostgreSQL)]
  W[Worker<br/>poll jobs FOR UPDATE SKIP LOCKED] -->|claim job, write notification,<br/>mark done - one transaction| P
  B -.->|GET /notifications| A
```

### Workflow

```mermaid
stateDiagram-v2
  [*] --> open
  open --> in_progress: Start work (assignee)
  in_progress --> awaiting_approval: Request approval (assignee / lead)
  awaiting_approval --> resolved: Approve (LEAD only)
  awaiting_approval --> in_progress: Reject (LEAD only)
  resolved --> closed: Close (lead)
  resolved --> in_progress: Reopen (member)
  closed --> [*]
```

### Permission matrix (minimum role *in the item's team*)

| Action | viewer | member | lead | admin |
|---|:-:|:-:|:-:|:-:|
| Read items / history | x | x | x | x |
| Create, edit, claim, comment | | x | x | x |
| Start work / request approval | | assignee only | x | x |
| Approve, reject, close | | | x | x |

Every item endpoint goes through one function, `assertCan` (`src/permissions.ts`), plus the list queries
are always scoped to the caller's teams. Non-members get **404** (the item's existence isn't revealed),
members with too low a role get **403**.

### API

| Method & path | Notes |
|---|---|
| `POST /api/auth/login` | `{email, password}` -> `{token}` |
| `GET /api/me`, `GET /api/dashboard` | profile + teams; counts for the three dashboard views |
| `GET /api/items` | `view`, `status`, `priority`, `type`, `team_id`, `assignee` (`me`/`unassigned`/id), `q`, `limit`, `cursor` |
| `POST /api/items` | create (supports `Idempotency-Key`) |
| `GET /api/items/:id` | detail + `allowed` actions for the caller |
| `PATCH /api/items/:id` | requires `version`; 409 with the latest item on mismatch |
| `POST /api/items/:id/claim` | atomic; 409 if already claimed |
| `POST /api/items/:id/transition` | `{to, version?}` |
| `POST /api/items/:id/comments`, `GET /api/items/:id/activity` | comments; append-only timeline |
| `GET /api/notifications` | produced by the worker |

Errors: `{ "error": { "code", "message", ... } }`; `409` responses include `error.latest` (the current item).
`401` unauthenticated · `403` forbidden · `404` not found/not visible · `409` conflict · `422` rule violation · `400` validation.

## Project layout

```
migrations/001_init.sql   schema, indexes, append-only trigger
src/items.ts              all item commands + queries (transactions, locking, history, outbox)
src/permissions.ts        role matrix + the single permission check
src/workflow.ts           allowed transitions
src/idempotency.ts        Idempotency-Key handling
src/worker.ts, jobs.ts    outbox worker and idempotent handlers
src/app.ts                routes, validation, error mapping
public/index.html         the UI
tests/                    see table above
ENGINEERING_DECISIONS.md  design decisions and trade-offs
```

## Known limitations

- **No reassign / release / unassign.** Ownership only changes through *claim*. Natural next step: "Leads can reassign" (a new endpoint with the same version check, activity event and `assignment` job).
- **Auth is deliberately simple**: seeded users, JWT in `localStorage` (XSS would expose it; a production app would use httpOnly cookies), no refresh/revocation, no rate limiting, no password reset. No UI for managing users/teams/roles (admin == lead in capabilities).
- **Notifications are rows in a table**, not email/Slack; no read/unread state.
- **Idempotency keys are never purged** (needs a TTL job) and `PATCH` relies on `version` instead of keys. A retried `claim` *without* a key by the same user returns 409 (they already own it).
- **Lists sort by creation time only.** Multi-team lists use `team_id = ANY(...)`; fine for tens of thousands of rows (verified with a 20k-row query-plan test), see decision 7 for what changes at 10x. Dashboard counts use `count(*)`.
- Search uses Postgres full-text (`simple` config, no stemming) plus a substring match on the title.
- The UI is plain JS with 15-second polling (no websockets); the list is not auto-refreshed while you look at it (use *Refresh*). Activity timeline shows the latest 100 events.
- The app runs TypeScript through `tsx` (no compile step) to keep setup minimal.
- Seed data assigns items to the first one or two members of each team, so some users have large "assigned to me" counts.

## Next week I would...

1. Add `reassign`/`release` with a Lead check, and a `due soon / overdue` dashboard view.
2. Move to httpOnly-cookie sessions, add login rate limiting and an admin screen for teams/roles.
3. Real delivery in the worker (email/Slack) with a dead-letter view and a retry button for `failed` jobs.
4. TTL cleanup for idempotency keys; partition `activity_events` by month; read replica for list/search.
5. CI (GitHub Actions: Postgres service + `npm test`), and a Playwright browser test on top of the jsdom UI tests.
