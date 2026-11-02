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
  properties TEXT NOT NULL DEFAULT '{}'      -- JSON: the app's own attributes, scrubbed
);
CREATE INDEX actions_name ON actions (project_id, name, timestamp);
CREATE INDEX actions_user ON actions (project_id, user_hash, timestamp) WHERE user_hash IS NOT NULL;
CREATE INDEX actions_trace ON actions (trace_id) WHERE trace_id IS NOT NULL;
