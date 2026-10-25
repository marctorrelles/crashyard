-- Projects, the issues their events group into, the events themselves, and where notifications go.
-- Times are milliseconds since 1970 (INTEGER); days are 'YYYY-MM-DD' (UTC).

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,                    -- the DSN's project id
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'other',    -- apple, android, javascript, node, other: which linking guide
  public_key TEXT NOT NULL UNIQUE,           -- the DSN's key: public, it ships inside apps
  daily_event_quota INTEGER NOT NULL DEFAULT 10000,
  event_retention_days INTEGER NOT NULL DEFAULT 90,
  created_at INTEGER NOT NULL
);

-- Auth tokens for sentry-cli and the build plugins; only the SHA-256 of the token is kept
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,                      -- space-separated
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  culprit TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'error',        -- error (an exception), message, csp…
  level TEXT NOT NULL DEFAULT 'error',
  platform TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'unresolved', -- unresolved, resolved, ignored
  substatus TEXT,                            -- new, regressed, ongoing (unresolved); for_good, until_count, until_date (ignored)
  resolved_in_release TEXT,                  -- resolved "in the next release": the release it was resolved against
  ignore_until_count INTEGER,                -- ignored for N more events: the count that ends it
  ignore_until INTEGER,                      -- ignored until a time
  count INTEGER NOT NULL DEFAULT 0,
  user_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  first_release TEXT,
  last_release TEXT,
  last_event_id TEXT,
  minute INTEGER NOT NULL DEFAULT 0,         -- spike protection: the minute counted, and events in it
  minute_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX issues_project_last_seen ON issues (project_id, status, last_seen DESC);
CREATE INDEX issues_last_seen ON issues (last_seen DESC);

CREATE TABLE issue_days (
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (issue_id, day)
) WITHOUT ROWID;

-- The top values of each tag per issue (release, os, device…), as Sentry's tag sidebar shows them
CREATE TABLE issue_tag_values (
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (issue_id, key, value)
) WITHOUT ROWID;

-- Distinct users per issue, by the app's user id, hashed
CREATE TABLE issue_users (
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  user_hash TEXT NOT NULL,
  PRIMARY KEY (issue_id, user_hash)
) WITHOUT ROWID;

-- Everything that happened to an issue: created, resolved, reopened, regressed, ignored, notes…
CREATE TABLE issue_activity (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT,                                 -- JSON
  by TEXT,                                   -- who (Access email), or null for crashyard itself
  at INTEGER NOT NULL
);
CREATE INDEX issue_activity_issue ON issue_activity (issue_id, at);

CREATE TABLE events (
  id TEXT PRIMARY KEY,                       -- the SDK's event id, 32 hex characters
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,                -- when it happened, from the SDK
  received INTEGER NOT NULL,
  level TEXT NOT NULL,
  platform TEXT NOT NULL,
  release TEXT,
  environment TEXT,
  message TEXT NOT NULL DEFAULT '',          -- title and message, for search
  data TEXT NOT NULL,                        -- the normalised event as JSON: exception, frames, contexts, breadcrumbs…
  envelope_key TEXT                          -- the raw envelope in R2
);
CREATE INDEX events_issue ON events (issue_id, received DESC);
CREATE INDEX events_project ON events (project_id, received DESC);

CREATE TABLE event_tags (
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (event_id, key)
) WITHOUT ROWID;
CREATE INDEX event_tags_lookup ON event_tags (project_id, key, value);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  issue_id INTEGER REFERENCES issues (id) ON DELETE CASCADE,
  event_id TEXT,
  name TEXT,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX feedback_issue ON feedback (issue_id);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL
);
CREATE INDEX attachments_event ON attachments (event_id);

-- Quotas: what each project took in each day
CREATE TABLE project_days (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
) WITHOUT ROWID;

-- Where notifications go (ntfy, email, webhook), and which go where
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                        -- ntfy, email, webhook
  name TEXT NOT NULL,
  config TEXT NOT NULL,                      -- JSON: ntfy {server, topic, token?}; email {to}; webhook {url, format}
  quiet_from INTEGER,                        -- quiet hours, minutes after midnight UTC
  quiet_to INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE routes (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE, -- null: every project
  kinds TEXT NOT NULL,                       -- JSON array: new, threshold, regression, ignore_expired, review_crash…
  levels TEXT,                               -- JSON array, null for every level
  environments TEXT,                         -- JSON array, null for every environment
  thresholds TEXT NOT NULL DEFAULT '[10,100,1000]',
  channel_ids TEXT NOT NULL,                 -- JSON array
  created_at INTEGER NOT NULL
);

-- Notifications held during a channel's quiet hours, sent as one when they end
CREATE TABLE held_notifications (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- Full-text search over issues and events (SQLite FTS5, kept in step by triggers)
CREATE VIRTUAL TABLE issues_fts USING fts5 (title, culprit, content = 'issues', content_rowid = 'id');
CREATE TRIGGER issues_fts_insert AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts (rowid, title, culprit) VALUES (new.id, new.title, new.culprit);
END;
CREATE TRIGGER issues_fts_delete AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, culprit) VALUES ('delete', old.id, old.title, old.culprit);
END;
CREATE TRIGGER issues_fts_update AFTER UPDATE OF title, culprit ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, culprit) VALUES ('delete', old.id, old.title, old.culprit);
  INSERT INTO issues_fts (rowid, title, culprit) VALUES (new.id, new.title, new.culprit);
END;
