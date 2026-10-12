-- Platform: a project and task tracker.
-- Highlights: per-project roles, a status workflow, per-project task numbers,
-- optimistic locking (version), dependencies, and an activity log that the
-- metrics are computed from.

CREATE TYPE member_role   AS ENUM ('owner', 'maintainer', 'member', 'viewer');
CREATE TYPE task_status   AS ENUM ('backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'normal', 'high', 'urgent');

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  handle        TEXT        NOT NULL CHECK (handle ~ '^[a-z0-9_]{2,24}$'),
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq  ON users (lower(email));
CREATE UNIQUE INDEX users_handle_uq ON users (handle);

CREATE TABLE projects (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT        NOT NULL UNIQUE CHECK (key ~ '^[A-Z]{2,6}$'),
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  wip_limit   INT         NOT NULL DEFAULT 3 CHECK (wip_limit BETWEEN 1 AND 20),
  next_number INT         NOT NULL DEFAULT 1,   -- per-project counter: PLAT-1, PLAT-2 ...
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE project_members (
  project_id BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL REFERENCES users(id),
  role       member_role NOT NULL,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);

CREATE TABLE tasks (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       INT           NOT NULL,
  title        TEXT          NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description  TEXT          NOT NULL DEFAULT '',
  status       task_status   NOT NULL DEFAULT 'backlog',
  priority     task_priority NOT NULL DEFAULT 'normal',
  assignee_id  BIGINT        REFERENCES users(id),
  reporter_id  BIGINT        NOT NULL REFERENCES users(id),
  due_date     DATE,
  position     NUMERIC       NOT NULL,           -- fractional order within the project
  version      INT           NOT NULL DEFAULT 1, -- optimistic locking
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (project_id, number),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status, position);
CREATE INDEX tasks_assignee_open_idx  ON tasks (assignee_id) WHERE status <> 'done';

CREATE TABLE task_dependencies (
  task_id       BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX task_dependencies_reverse_idx ON task_dependencies (depends_on_id);

CREATE TABLE comments (
  id         BIGSERIAL PRIMARY KEY,
  task_id    BIGINT      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  BIGINT      NOT NULL REFERENCES users(id),
  body       TEXT        NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_task_idx ON comments (task_id, created_at);

CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id),
  task_id    BIGINT      REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT        NOT NULL,
  message    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ
);
CREATE INDEX notifications_unread_idx ON notifications (user_id, id DESC) WHERE read_at IS NULL;

-- Append-only event log. Status changes recorded here drive cycle-time metrics.
CREATE TABLE activity (
  id         BIGSERIAL PRIMARY KEY,
  project_id BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    BIGINT      REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   BIGINT      REFERENCES users(id),
  kind       TEXT        NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_project_idx ON activity (project_id, id DESC);
CREATE INDEX activity_task_idx    ON activity (task_id, id DESC);

-- Keeps updated_at honest without trusting every query to set it.
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
