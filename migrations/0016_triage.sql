-- Triage: the files each commit changed (suspect commits), grouping rules and versions, inbound filters, fingerprints
-- whose events are dropped, who an issue is assigned to, its tracker link, bookmarks and when each person last
-- opened an issue.

-- The paths a commit from set-commits changed, as sentry-cli's patch_set sends them
CREATE TABLE commit_files (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  path TEXT NOT NULL,                        -- from the repository's root
  kind TEXT NOT NULL,                        -- A, M or D
  PRIMARY KEY (project_id, path, sha)
) WITHOUT ROWID;

-- Fingerprint and stack trace rules in Sentry's syntax, one a line (src/ingest/rules.ts); null for none
ALTER TABLE projects ADD COLUMN grouping_rules TEXT;
-- The grouping the project's events are hashed with (GROUPING_VERSION), the one before while both are computed, and
-- until when
ALTER TABLE projects ADD COLUMN grouping_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN grouping_previous INTEGER;
ALTER TABLE projects ADD COLUMN grouping_until INTEGER;
-- JSON, the inbound filters that are on and their lists (src/ingest/filters.ts); null for none
ALTER TABLE projects ADD COLUMN filters TEXT;

-- The grouping an event was hashed with, and its fingerprint before any merge; null for events stored before 0016
ALTER TABLE events ADD COLUMN grouping_version INTEGER;
ALTER TABLE events ADD COLUMN fingerprint TEXT;
CREATE INDEX events_issue_fingerprint ON events (issue_id, fingerprint);

-- "Delete and discard future events": ingest drops these and counts them as filtered
CREATE TABLE discarded_fingerprints (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
) WITHOUT ROWID;

ALTER TABLE issues ADD COLUMN assignee TEXT;            -- an email, or null
ALTER TABLE issues ADD COLUMN external_url TEXT;        -- a linked GitHub, Linear or other tracker issue
ALTER TABLE issues ADD COLUMN resolved_in_commit TEXT;  -- the sha whose "Fixes" resolved it
-- Resolved in this release: its events and a newer release's reopen it, an older release's don't
ALTER TABLE issues ADD COLUMN fixed_in_release TEXT;
CREATE INDEX issues_assignee ON issues (assignee) WHERE assignee IS NOT NULL;

CREATE TABLE bookmarks (
  email TEXT NOT NULL,
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  PRIMARY KEY (email, issue_id)
) WITHOUT ROWID;
CREATE INDEX bookmarks_issue ON bookmarks (issue_id);

-- When each person last opened an issue: an issue last seen after it is unread
CREATE TABLE issue_views (
  email TEXT NOT NULL,
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  PRIMARY KEY (email, issue_id)
) WITHOUT ROWID;
CREATE INDEX issue_views_issue ON issue_views (issue_id);
