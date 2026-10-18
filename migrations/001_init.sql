-- Operations Under Pressure: initial schema.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

-- A user can belong to many teams, with one role per team.
CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role    text NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX memberships_team_idx ON memberships(team_id);

CREATE TABLE work_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams(id),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  type        text NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority    text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  assignee_id uuid REFERENCES users(id),
  created_by  uuid NOT NULL REFERENCES users(id),
  due_date    date,
  version     integer NOT NULL DEFAULT 1,   -- optimistic locking token, bumped on every change
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search_vec  tsvector GENERATED ALWAYS AS
              (to_tsvector('simple', title || ' ' || description)) STORED
);

-- Keyset pagination (created_at DESC, id DESC) scoped by team
CREATE INDEX work_items_team_created_idx ON work_items (team_id, created_at DESC, id DESC);
CREATE INDEX work_items_created_idx      ON work_items (created_at DESC, id DESC);
-- "Assigned to me"
CREATE INDEX work_items_assignee_idx ON work_items (assignee_id, created_at DESC, id DESC)
  WHERE assignee_id IS NOT NULL;
-- "Unassigned urgent" (partial index = tiny and fast)
CREATE INDEX work_items_unassigned_urgent_idx ON work_items (team_id, created_at DESC, id DESC)
  WHERE assignee_id IS NULL AND priority = 'urgent'
    AND status IN ('open','in_progress','awaiting_approval');
-- "Awaiting approval"
CREATE INDEX work_items_awaiting_idx ON work_items (team_id, created_at DESC, id DESC)
  WHERE status = 'awaiting_approval';
CREATE INDEX work_items_status_idx   ON work_items (team_id, status, created_at DESC);
-- Search: full text + substring on title
CREATE INDEX work_items_search_idx ON work_items USING gin (search_vec);
CREATE INDEX work_items_title_trgm ON work_items USING gin (title gin_trgm_ops);

-- Append-only history. Written in the SAME transaction as the change it describes.
CREATE TABLE activity_events (
  id         bigserial PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES work_items(id),
  actor_id   uuid NOT NULL REFERENCES users(id),
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_item_idx ON activity_events (item_id, id DESC);

CREATE FUNCTION forbid_activity_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER activity_events_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_activity_mutation();

CREATE TABLE comments (
  id         bigserial PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES work_items(id),
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_item_idx ON comments (item_id, id);

-- Replay protection for retried / double-submitted POSTs.
CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users(id),
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  integer,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Transactional outbox.
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pending_idx ON jobs (run_at, id) WHERE status = 'pending';

-- Output of the async worker (stand-in for email/Slack delivery).
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  item_id    uuid NOT NULL REFERENCES work_items(id),
  message    text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,         -- makes the job handler idempotent
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
