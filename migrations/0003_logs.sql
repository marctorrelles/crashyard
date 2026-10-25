-- Logs (Sentry's structured logs: Sentry.logger.info(...)), their attributes for search and facets, and their own
-- quota and retention. Events keep their trace id, to link an issue to the logs of the same trace.
CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,                -- when it was logged, from the SDK
  received INTEGER NOT NULL,
  level TEXT NOT NULL,                       -- trace, debug, info, warn, error, fatal
  body TEXT NOT NULL,
  attributes TEXT NOT NULL,                  -- JSON: every attribute, { key: value }
  release TEXT,
  environment TEXT,
  trace_id TEXT
);
CREATE INDEX logs_project_time ON logs (project_id, timestamp DESC, id DESC);
CREATE INDEX logs_time ON logs (timestamp DESC, id DESC);
CREATE INDEX logs_trace ON logs (trace_id) WHERE trace_id IS NOT NULL;

-- The app's own attributes (not sentry.*), indexed for `key:value` search and the facets
CREATE TABLE log_attributes (
  log_id INTEGER NOT NULL REFERENCES logs (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (log_id, key)
) WITHOUT ROWID;
CREATE INDEX log_attributes_lookup ON log_attributes (project_id, key, value);

CREATE VIRTUAL TABLE logs_fts USING fts5 (body, content = 'logs', content_rowid = 'id');
CREATE TRIGGER logs_fts_insert AFTER INSERT ON logs BEGIN
  INSERT INTO logs_fts (rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER logs_fts_delete AFTER DELETE ON logs BEGIN
  INSERT INTO logs_fts (logs_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

ALTER TABLE projects ADD COLUMN daily_log_quota INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE projects ADD COLUMN log_retention_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE project_days ADD COLUMN logs INTEGER NOT NULL DEFAULT 0;

ALTER TABLE events ADD COLUMN trace_id TEXT;
CREATE INDEX events_trace ON events (trace_id) WHERE trace_id IS NOT NULL;
