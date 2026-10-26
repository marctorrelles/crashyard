-- Linking stacks to the code: a project's repository, the files in it and each release's commits, as sentry-cli's
-- `releases set-commits --local` sends them (src/api/sentry.ts)
ALTER TABLE projects ADD COLUMN repo_url TEXT; -- e.g. https://github.com/owner/repo, set in the project's settings

-- Every path the commits sent so far added and didn't delete: what a frame's file is matched against
CREATE TABLE source_files (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path TEXT NOT NULL, -- from the repository's root
  PRIMARY KEY (project_id, path)
) WITHOUT ROWID;

-- A release's commits since the release before, newest first (position 0 is the release's head, also releases.ref)
CREATE TABLE release_commits (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  position INTEGER NOT NULL,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  author TEXT,
  at INTEGER, -- the commit's time
  PRIMARY KEY (project_id, version, position)
) WITHOUT ROWID;
