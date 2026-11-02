-- Product analytics: what people do in an app, sent as a Sentry log whose attributes mark it `crashyard.action`.
-- One row an action. user_hash is hashed as events' are (src/search/user.ts), so an action joins its user's errors.
CREATE TABLE actions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  name TEXT NOT NULL,
  user_hash TEXT,                            -- null when the app set no user
  release TEXT,
  environment TEXT,
  trace_id TEXT,
  platform TEXT,                             -- from the SDK's name: Web, Apple, Android, Flutter, Server…
  os TEXT,                                   -- the log's os.name, when the SDK sends it
  device TEXT,                               -- device.model, else device.family
  browser TEXT,                              -- browser.name
  country TEXT,                              -- ISO 3166 code from Cloudflare at the request, never from an IP kept
  properties TEXT NOT NULL DEFAULT '{}'      -- JSON: the app's own attributes, scrubbed
);
CREATE INDEX actions_name ON actions (project_id, name, timestamp);
CREATE INDEX actions_user ON actions (project_id, user_hash, timestamp) WHERE user_hash IS NOT NULL;
CREATE INDEX actions_trace ON actions (trace_id) WHERE trace_id IS NOT NULL;

-- How long a project keeps its actions, longer than events: retention is read over months
ALTER TABLE projects ADD COLUMN action_retention_days INTEGER NOT NULL DEFAULT 365;

-- Funnels saved on the analytics page, a project's, by whoever saved them
CREATE TABLE funnels (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,                       -- JSON list of action names, 2 to 8
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX funnels_project ON funnels (project_id, created_at DESC);
