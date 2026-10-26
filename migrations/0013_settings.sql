-- The deployment's own settings, edited on the settings pages: one JSON value per key (src/data/settings.ts), such as
-- new-project defaults, extra fields to scrub, whether agents may change issues, and the cron's last run
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL, -- JSON
  updated_by TEXT,     -- the viewer's email, or null for the worker itself
  updated_at INTEGER   -- ms
);

-- Each person's own preferences, by their Access email: theme, time zone, clock, stack order, home
CREATE TABLE preferences (
  email TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL, -- JSON
  PRIMARY KEY (email, key)
);

-- A project's client keys, the public part of its DSNs: several per project, each with a label, a switch and its own
-- daily event limit (null for none beyond the project's). Ingest reads these; projects.public_key stays as the first
-- key so a worker from before 0013 still takes it
CREATE TABLE project_keys (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'Default',
  enabled INTEGER NOT NULL DEFAULT 1,
  daily_limit INTEGER,
  created_at INTEGER NOT NULL -- ms
);
CREATE INDEX project_keys_project ON project_keys (project_id, id);
INSERT INTO project_keys (project_id, public_key, label, created_at)
SELECT id, public_key, 'Default', created_at FROM projects;
-- A new project's first key, whoever inserts it: createProject, a worker from before 0013, the seed or a test
CREATE TRIGGER projects_default_key AFTER INSERT ON projects BEGIN
  INSERT INTO project_keys (project_id, public_key, label, created_at)
  VALUES (new.id, new.public_key, 'Default', new.created_at);
END;

-- Events each key sent per UTC day, for its daily limit and the keys page
CREATE TABLE key_days (
  key_id INTEGER NOT NULL REFERENCES project_keys (id) ON DELETE CASCADE,
  day TEXT NOT NULL, -- YYYY-MM-DD
  events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
) WITHOUT ROWID;

-- Notifications a channel refused, for the health page; the cron deletes them after 30 days
CREATE TABLE notification_failures (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER, -- the channel it was for, which may be deleted since
  kind TEXT NOT NULL, -- the notice's kind: new, regression, threshold, test…
  error TEXT NOT NULL,
  at INTEGER NOT NULL -- ms
);
CREATE INDEX notification_failures_at ON notification_failures (at);

-- An upload token for one project only; null is every project, as tokens were before
ALTER TABLE tokens ADD COLUMN project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE;

-- Resolve issues not seen for this many days, hourly by the cron; null is off
ALTER TABLE projects ADD COLUMN auto_resolve_days INTEGER;
