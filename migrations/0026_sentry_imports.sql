-- Issues brought in from Sentry (src/ingest/import.ts), so importing again skips them
CREATE TABLE sentry_imports (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  sentry_issue_id TEXT NOT NULL,             -- the issue's id in Sentry
  issue_id INTEGER REFERENCES issues (id) ON DELETE SET NULL, -- what it became here
  at INTEGER NOT NULL,
  PRIMARY KEY (project_id, sentry_issue_id)
) WITHOUT ROWID;
