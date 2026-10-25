-- A merged issue's fingerprints keep sending their events to the issue it was merged into
CREATE TABLE issue_fingerprints (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, fingerprint)
) WITHOUT ROWID;
CREATE INDEX issue_fingerprints_issue ON issue_fingerprints (issue_id);

-- The releases page: a project's events by release
CREATE INDEX events_release ON events (project_id, release, received);
