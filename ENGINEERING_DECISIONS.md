# Engineering Decisions

Each decision lists the context, the options I considered, what I chose, and the trade-off I accepted.

## Assumptions I made (I would confirm these with a product manager first)

1. A work item belongs to **exactly one team**; a user can be in several teams with **one role per team**. Permissions are always evaluated against the item's team.
2. **Assignment happens by claiming.** Items are created unassigned; a Member+ claims them. There is no reassign yet (listed as a limitation and a likely live-coding change).
3. "Approval" means a **Lead (or Admin) of that team** moves `awaiting_approval -> resolved`. A member can never approve, even their own work.
4. **Closed is terminal** and closed items are read-only (comments excepted). A *resolved* item can be reopened by a member.
5. "Urgent" = `priority = urgent`. "Unassigned urgent" only counts active items (not resolved/closed).
6. Viewers can read everything in their teams but write nothing.

## 1. Plain SQL on PostgreSQL, no ORM

**Context.** The brief is about concurrency, atomicity and indexes. I need to say exactly which statement takes which lock, and which rows a `WHERE` clause matches.
**Options.** Prisma/Drizzle/ORM; query builder; plain `pg`.
**Choice.** Plain parameterised SQL with `pg`, a tiny `tx()` helper, zod for input validation, and SQL migrations.
**Trade-off.** More boilerplate and no compile-time column types, in exchange for every concurrency-relevant statement being visible and explainable line by line (`UPDATE ... WHERE id=$1 AND assignee_id IS NULL`). I'd reconsider an ORM/typed query builder once the schema grows.

## 2. Concurrency: conditional updates + an optimistic `version`

**Context.** Two people can claim the same item; a tab can hold a stale copy; transitions race with edits.
**Options.** (a) `SELECT ... FOR UPDATE` pessimistic locks; (b) optimistic locking with a version column; (c) application-level mutex/queue.
**Choice.** 
- *Claim*: a single atomic `UPDATE ... WHERE assignee_id IS NULL`; 0 rows -> `409 already_claimed` (with the latest item so the UI can explain who won).
- *Edit / transition*: every write bumps `version`; the update is `WHERE id=$1 AND version=$2`. A stale client gets `409 stale_version` plus the current item. Transitions also condition on the version they validated against, so a rule check can't be invalidated by a concurrent change between "read" and "write".
**Trade-off.** Optimistic locking pushes conflict handling to the client (the UI shows "this item changed, reload"), but it holds no locks while a user is thinking, never blocks other users, and works across multiple API instances because the database is the arbiter. Under heavy contention on one hot row users would see more 409s; for this workload that is the right failure mode. Tests: 8 parallel claims, two simultaneous edits from the same version, stale edit leaves data unchanged.

## 3. Idempotency keys stored in the same transaction as the change

**Context.** Double clicks, flaky networks and client retries must not create duplicates.
**Options.** In-memory/Redis dedupe cache; unique business key; a table of keys written *after* the work.
**Choice.** `Idempotency-Key` header on create/claim/transition/comment. The key row is inserted *first, inside the same transaction* as the business change, with `ON CONFLICT DO NOTHING`. The first request runs and stores its response; a concurrent duplicate blocks on the unique index until the first commits and then replays the stored response (header `Idempotent-Replayed: true`). A different payload with the same key is `422`. If the first attempt fails, its transaction rolls back and the key disappears, so a retry runs normally.
**Trade-off.** Needs no extra infrastructure and is correct for *parallel* duplicates (tested with 6 simultaneous requests), but keys live forever until a cleanup job exists, and the key is optional (the UI always sends one; the create form reuses one key per opened form so retries are safe).

## 4. Authorization: one check, scoped queries, roles read from the DB

**Context.** Hidden buttons are not security. Rules depend on team + role + (for some transitions) assignee.
**Options.** Role claims inside the JWT; middleware per route; a central permission function.
**Choice.** The JWT carries only the user id. Memberships are loaded from the DB on every request, so removing someone from a team takes effect immediately. Every item action loads the row and calls the single `assertCan(user, item.team_id, action)` (`src/permissions.ts`); list/count queries always start with `team_id = ANY(user's teams)`. Transition rules live in a declarative table in `src/workflow.ts` and the same function (`checkTransition`) both enforces them and computes the `allowed` hints sent to the UI, so the UI can never offer something the server would refuse for a different reason. Non-members receive **404** (don't reveal existence); members lacking the role receive **403**.
**Trade-off.** One extra tiny query per request instead of stateless tokens; simpler to reason about and no stale-permission window. The UI hiding is purely cosmetic - tests hit the API directly as other-team users and viewers.

## 5. History: same transaction, append-only at the database level

**Context.** "History must never disagree with the item."
**Options.** Write the log after the update; DB triggers that audit every column; full event sourcing.
**Choice.** Every command writes its `activity_events` row(s) in the *same transaction* as the item change (`created`, `claimed`, `status_changed`, `priority_changed`, `item_updated` with from/to, `comment_added`). A `BEFORE UPDATE OR DELETE` trigger makes the table append-only even for buggy code. A test forces a failure after a claim and proves the item, event and job all roll back together.
**Trade-off.** Explicit application-level events carry intent (who/why/from/to) that a generic audit trigger can't, at the cost of having to remember to log in each command (they're all in `items.ts`). Not full event sourcing: the `work_items` row is the source of truth and the log is its audit trail.

## 6. Async work: transactional outbox + Postgres-backed worker

**Context.** Notifying people must not slow down or break the request, and must not be lost or sent for a change that rolled back.
**Options.** Fire-and-forget after commit (can be lost); publish to a broker inside the request (dual-write problem); BullMQ/Redis; outbox table in Postgres.
**Choice.** The job row is inserted in the same transaction as the change. The worker takes jobs with `FOR UPDATE SKIP LOCKED` (several workers never share a job), runs the handler inside the same transaction as the "done" mark, uses a savepoint so a failed handler's partial writes are undone, retries with exponential backoff (2s, 4s, ... max 5 min), and marks the job `failed` after 5 attempts. Handlers are idempotent (`notifications.dedupe_key` unique + `ON CONFLICT DO NOTHING`), so at-least-once delivery yields exactly one notification.
**Trade-off.** Postgres polling (1s) adds latency and load compared with a real queue, but removes an infrastructure dependency and the dual-write problem. If the worker crashes mid-job the transaction rolls back and the job is simply retried.

## 7. Pagination, search and scale

**Context.** "Tens of thousands of items and a growing history."
**Choice.** Server-side keyset pagination on `(created_at DESC, id DESC)` (no OFFSET, stable under inserts, `id` as tie-breaker; the cursor carries `created_at` as text so microseconds survive). Indexes: `(team_id, created_at, id)`, partial indexes for *assigned to me*, *unassigned urgent* and *awaiting approval*, GIN on a generated `tsvector` plus `pg_trgm` on the title for search. A test seeds 20,000 rows and asserts the plan uses an index.
**What changes at 10x.** (1) Read replicas for list/search/dashboard; (2) partition `activity_events` by month and keep only recent events hot; (3) move search to OpenSearch/Meilisearch if relevance/stemming matters; (4) replace `count(*)` dashboard counts with maintained counters or cached approximations; (5) a dedicated queue (SQS/Redis streams) and websockets/SSE instead of 15s polling; (6) for users in many teams, replace `team_id = ANY(...)` with a precomputed visible-teams join or per-team cursors.
**Trade-off.** Keyset pagination can't jump to "page 7"; fine for an inbox-style work queue.

## What I chose not to build

Email delivery, attachments, SSO, websockets, reassignment, user/team admin screens, and a SPA framework/build step. Each is a deliberate cut so the concurrency, authorization, history and async paths are complete and tested rather than the feature list being long.
